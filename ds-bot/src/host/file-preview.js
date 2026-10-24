// A file a Bot sent, read into something the chat can show: Office files are zips of
// XML parts, so the host reads the parts itself with zlib and no extra package. Only
// what a reader can scan in a panel comes out of here — a table's first rows, a
// document's paragraphs — never a claim that the whole file was rendered.
import { inflateRawSync } from 'node:zlib'

// The first rows and columns a preview shows; past that the file is one to open.
export const PREVIEW_ROWS = 200
export const PREVIEW_COLS = 40
// The largest file the preview reads whole (the bytes are already in memory).
export const PREVIEW_MAX = 32 * 1024 * 1024
// Characters of a document or text file the panel keeps.
export const PREVIEW_CHARS = 200_000

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

// The end-of-central-directory record ends the archive and sits within its last 64 KB.
function endRecord(buffer) {
  const floor = Math.max(0, buffer.length - 65558)
  for (let at = buffer.length - 22; at >= floor; at--) {
    if (buffer.readUInt32LE(at) === EOCD) return at
  }
  return -1
}

// The archive's files, by name. Zip64 entries (an FFFFFFFF size) are skipped rather
// than guessed at; a file this code cannot inflate is left out.
export function zipFiles(buffer) {
  const eocd = endRecord(buffer)
  if (eocd < 0) return null
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let index = 0; index < count; index++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) break
    const method = buffer.readUInt16LE(at + 10)
    const packed = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength
    const zip64 = packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff
    if (zip64 || local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) continue
    const localName = buffer.readUInt16LE(local + 26)
    const localExtra = buffer.readUInt16LE(local + 28)
    const from = local + 30 + localName + localExtra
    const raw = buffer.subarray(from, Math.min(from + packed, buffer.length))
    try {
      files.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null)
    } catch {
      files.set(name, null)
    }
  }
  return files
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function unescapeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/g, (match, name) => ENTITIES[name] ?? match)
}

// A Word document: its paragraphs, in order. Tables keep their text, row by row.
export function docxText(files) {
  const part = files.get('word/document.xml')
  if (part === null || part === undefined) return null
  const body = part.toString('utf8').match(/<w:body\b[\s\S]*<\/w:body>/)?.[0] ?? part.toString('utf8')
  const lines = []
  for (const para of body.match(/<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const text = [...para.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g)]
      .map(([match, value]) => (value === undefined ? (/<w:tab/.test(match) ? '\t' : '\n') : unescapeXml(value)))
      .join('')
    lines.push(text)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// A workbook: the name of the sheet shown, then its rows as arrays of strings.
export function xlsxRows(files, { rows = PREVIEW_ROWS, cols = PREVIEW_COLS } = {}) {
  const sheet = pickSheet(files)
  if (sheet?.part === null || sheet?.part === undefined) return null
  const shared = sharedStrings(files)
  const xml = sheet.part.toString('utf8')
  const out = []
  let truncated = false
  for (const row of xml.match(/<row\b[^>]*\/>|<row\b[\s\S]*?<\/row>/g) ?? []) {
    if (out.length >= rows) { truncated = true; break }
    const cells = []
    for (const cell of row.match(/<c\b([^>]*)\/>|<c\b([^>]*>)([\s\S]*?)<\/c>/g) ?? []) {
      const attributes = cell.match(/^<c\b([^>]*)/)?.[1] ?? ''
      const ref = attributes.match(/\br="([A-Z]+)\d+"/)?.[1] ?? ''
      const at = ref ? columnOf(ref) : cells.length
      const type = attributes.match(/\bt="([a-z]+)"/)?.[1] ?? ''
      const body = cell.match(/^<c\b[^>]*>([\s\S]*)<\/c>$/)?.[1] ?? ''
      const value = cellValue(body, type, shared)
      if (value === '' && at >= cols) continue
      if (at >= cols) continue
      while (cells.length < at) cells.push('')
      cells[at] = value
    }
    if (cells.length === 0) continue
    out.push(cells.slice(0, cols))
  }
  return { sheet: sheet.name, rows: out, truncated, columns: out.reduce((most, row) => Math.max(most, row.length), 0) }
}

// Sheets in the workbook's own order; the first one is what a reader expects.
function pickSheet(files) {
  const names = new Map()
  const book = files.get('xl/workbook.xml')
  const rels = files.get('xl/_rels/workbook.xml.rels')
  if (book !== null && book !== undefined) {
    const targets = new Map()
    if (rels !== null && rels !== undefined) {
      for (const rel of rels.toString('utf8').match(/<Relationship\b[^>]*\/>/g) ?? []) {
        const id = rel.match(/\bId="([^"]+)"/)?.[1]
        const target = rel.match(/\bTarget="([^"]+)"/)?.[1]
        if (id && target) targets.set(id, target.replace(/^\/?xl\//, 'xl/').replace(/^\//, ''))
      }
    }
    for (const entry of book.toString('utf8').match(/<sheet\b[^>]*\/>/g) ?? []) {
      const name = entry.match(/\bname="([^"]*)"/)?.[1] ?? ''
      const target = targets.get(entry.match(/\br:id="([^"]+)"/)?.[1] ?? '')
      if (target) names.set(`xl/${target.replace(/^xl\//, '')}`, name || 'Sheet')
    }
  }
  const candidates = [...files.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0))
  const first = candidates[0]
  if (first === undefined) return null
  return { name: names.get(first) ?? 'Sheet1', part: files.get(first) }
}

function sharedStrings(files) {
  const part = files.get('xl/sharedStrings.xml')
  if (part === null || part === undefined) return []
  return [...part.toString('utf8').match(/<si\b[\s\S]*?<\/si>/g) ?? []]
    .map(item => [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, value]) => unescapeXml(value)).join(''))
}

function columnOf(ref) {
  let at = 0
  for (const char of ref) at = at * 26 + (char.charCodeAt(0) - 64)
  return at - 1
}

function cellValue(body, type, shared) {
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, value]) => unescapeXml(value)).join('')
  }
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? ''
  if (raw === '') return ''
  if (type === 's') return shared[Number(unescapeXml(raw))] ?? ''
  return unescapeXml(raw)
}

// A plain file's text, when it is text: bytes that carry NUL are a program or an
// archive, which the panel would only garble.
export function textOf(buffer, { chars = PREVIEW_CHARS } = {}) {
  const bytes = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (bytes.includes(0)) return null
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const truncated = text.length > chars
  return { text: truncated ? text.slice(0, chars) : text, truncated }
}

// Kinds whose bytes are text the panel can print as they are.
const PLAIN = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini'])

// What the panel shows, or none of these when the kind is not one this reads.
export function previewOf(buffer, extension) {
  if (buffer.length > PREVIEW_MAX) return { kind: 'too-large' }
  if (extension === 'docx') {
    const files = zipFiles(buffer)
    const text = files === null ? null : docxText(files)
    if (text === null) return null
    const truncated = text.length > PREVIEW_CHARS
    return { kind: 'text', text: truncated ? text.slice(0, PREVIEW_CHARS) : text, truncated }
  }
  if (extension === 'xlsx') {
    const files = zipFiles(buffer)
    const table = files === null ? null : xlsxRows(files)
    return table === null ? null : { kind: 'table', ...table }
  }
  if (!PLAIN.has(extension)) return null
  const plain = textOf(buffer)
  return plain === null ? null : { kind: 'text', text: plain.text, truncated: plain.truncated }
}
