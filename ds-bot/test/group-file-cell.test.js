import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The group chat cells, bundled once and rendered with a minimal React: components run
// as plain functions and effects are collected, as in tool-cells.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: "export { TriggerCell } from './src/client/cells.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createElement: h, Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'cell-id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false },
  setTimeout: () => ({}), clearTimeout: () => {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      MarkdownText: ({ text }) => text,
      FileTypeIcon: ({ path }) => `icon:${path}`,
      fileExtension: path => path.slice(path.lastIndexOf('.') + 1),
      fileSizeText: bytes => `${bytes} B`,
    }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { TriggerCell } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props.children, match)
}
const count = (haystack, needle) => haystack.split(needle).length - 1

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const room = { id: 'room', name: 'Ops', members: ['writer'], admin: undefined }
const roster = { bots: [writer], byId: { writer }, rooms: [room], roomsById: { room }, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }

// A Bot's post in the group's Session, as the chat hands it to the trigger cell: its
// text and, with send_file, one file part per file it delivered.
const post = (content, source = {}) => ({
  key: 'turn-trigger:41', kind: 'turn-trigger', anchorSeq: 41, location: { turn: { turn: 3 } },
  data: { kind: 'context', seq: 41, time: 1, content, source: { kind: 'bot', role: 'post', senderSessionId: writer.id, senderName: writer.name, ...source }, producer: {}, form: null },
})
const draw = (node, actions = {}) => {
  const out = expand(TriggerCell({
    node, sessionId: 'room', actions,
    useRoster: select => select(roster), useSessions: select => select({ byId: {} }),
    useTurnClock: select => select({}), useUi: select => select({ visits: {}, reactions: {} }),
  }))
  effects = []
  return out
}

// The chip opens the file in the panel; the icon beside it downloads a copy instead.
test('a post with a file draws a chip that shows the file in the panel', () => {
  const file = { attachmentId: 'sha256:1', name: 'report.docx', bytes: 50073 }
  const opened = []
  const saved = []
  const node = draw(post([{ type: 'text', text: '[Group post from Writer]\nThe report.' }, { type: 'file', attachment: file }]), { previewFile: file => opened.push(file), downloadFile: file => saved.push(file) })
  const chip = find(node, item => item.props?.className === 'bt-gfile')
  assert.ok(chip, 'the file draws as a chip')
  assert.equal(chip.props.title, 'report.docx')
  assert.equal(count(JSON.stringify(node), 'bt-gfile"'), 1, 'one chip per file')
  chip.props.onClick()
  assert.deepEqual(opened, [file])
  const icon = find(chip, item => item.props?.className === 'bt-gfile-open')
  assert.ok(icon, 'the chip carries a download control')
  icon.props.onClick({ stopPropagation: () => {} })
  assert.deepEqual(saved, [file], 'the icon downloads without opening the panel')
})

test('two files in one post draw two chips', () => {
  const files = [
    { attachmentId: 'sha256:1', name: 'a.docx', bytes: 10 },
    { attachmentId: 'sha256:2', name: 'b.xls', bytes: 20 },
  ]
  const node = draw(post([{ type: 'text', text: '[Group post from Writer]' }, ...files.map(attachment => ({ type: 'file', attachment }))]))
  assert.equal(count(JSON.stringify(node), '"className":"bt-gfile"'), 2)
})

// A post past what a message holds came as a file of its own (attachLong): the text
// folds to "show all", and that file is the message, not a delivery, so it draws no
// chip of its own.
test('a long post keeps its show-all and draws no chip for its own file', () => {
  const file = { attachmentId: 'sha256:9', name: 'Post from Writer.txt', bytes: 9000 }
  const node = draw(post([{ type: 'text', text: '[Group post from Writer]\n[A long message: 9000 characters. Its start is below; all of it is in the attached file.' }, { type: 'file', attachment: file }], { length: 9000 }))
  assert.equal(count(JSON.stringify(node), '"className":"bt-gfile"'), 0)
  assert.ok(find(node, item => item.props?.className === 'bt-fold'), 'the text still folds to show all')
})

test('a post with no file draws no chip row', () => {
  const node = draw(post([{ type: 'text', text: '[Group post from Writer]\nJust words.' }]))
  assert.equal(count(JSON.stringify(node), 'bt-gfile'), 0)
  assert.match(JSON.stringify(node), /Just words\./)
})
