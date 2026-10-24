import assert from 'node:assert/strict'
import { test } from 'node:test'
import { docxText, previewOf, textOf, xlsxRows, zipFiles } from '../src/host/file-preview.js'
import { zipFixture as zip } from './fake-zip.js'

const DOCX = {
  'word/document.xml': '<w:document><w:body>'
    + '<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Second line</w:t></w:r><w:r><w:tab/><w:t>after a tab</w:t></w:r></w:p>'
    + '</w:body></w:document>',
}
const XLSX = {
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet One" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>36</v></c></row>'
    + '</sheetData></worksheet>',
}

test('the zip reader takes files out of an archive by name', () => {
  const files = zipFiles(zip({ 'a.txt': 'one', 'dir/b.xml': '<two/>' }))
  assert.equal(files.get('a.txt').toString('utf8'), 'one')
  assert.equal(files.get('dir/b.xml').toString('utf8'), '<two/>')
  assert.equal(zipFiles(Buffer.from('not an archive at all')), null, 'anything else is not a zip')
})

test('a Word document reads as its paragraphs', () => {
  const files = zipFiles(zip(DOCX))
  assert.equal(docxText(files), 'Hello & welcome\nSecond line\tafter a tab')
  assert.equal(docxText(zipFiles(zip({ 'nope.xml': '' }))), null, 'a zip without a document is not a docx')
})

test('a workbook reads as rows, with its shared strings in place', () => {
  const files = zipFiles(zip(XLSX))
  const table = xlsxRows(files)
  assert.equal(table.sheet, 'Sheet One')
  assert.deepEqual(table.rows, [['Name', '', 'Ada'], ['Ada', '36']], 'a skipped column stays empty')
  assert.equal(table.columns, 3)
  assert.equal(table.truncated, false)
  const short = xlsxRows(files, { rows: 1 })
  assert.deepEqual(short.rows, [['Name', '', 'Ada']])
  assert.equal(short.truncated, true, 'past the limit the reader says so')
  assert.equal(xlsxRows(zipFiles(zip({ 'xl/worksheets/sheet1.xml': '<worksheet/>' }))).rows.length, 0)
})

test('previewOf answers with what a panel can show, and nothing for the rest', () => {
  assert.deepEqual(previewOf(zip(DOCX), 'docx'), { kind: 'text', text: 'Hello & welcome\nSecond line\tafter a tab', truncated: false })
  const table = previewOf(zip(XLSX), 'xlsx')
  assert.equal(table.kind, 'table')
  assert.equal(table.sheet, 'Sheet One')
  assert.deepEqual(table.rows[0], ['Name', '', 'Ada'])
  assert.deepEqual(previewOf(Buffer.from('# Title\ntext'), 'md'), { kind: 'text', text: '# Title\ntext', truncated: false })
  assert.equal(previewOf(Buffer.from([1, 0, 2, 0]), 'bin'), null, 'bytes that are not text are not guessed at')
  assert.equal(previewOf(Buffer.from('plain'), 'xls'), null, 'an old .xls is not a zip of parts')
})

test('a text preview keeps its length bounded and says when it cut', () => {
  const long = 'x'.repeat(5000)
  const shown = textOf(Buffer.from(long), { chars: 100 })
  assert.equal(shown.text.length, 100)
  assert.equal(shown.truncated, true)
  assert.equal(textOf(Buffer.from('short'), { chars: 100 }).truncated, false)
  assert.equal(textOf(Buffer.from([0, 1, 2])), null, 'NUL bytes mean the file is not text')
})
