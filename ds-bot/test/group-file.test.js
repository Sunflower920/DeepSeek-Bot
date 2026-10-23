import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { resolveSendFile } from '../src/host/tools.js'
import { GROUP_FILE_MAX } from '../src/host/constants.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// send_file: a Bot puts a file from the group's working folder into the group chat,
// where the user opens it. The bytes go to the attachment store once and the group's
// Session carries the reference, so nothing large rides in state.json and the file
// outlives the log line that announced it.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-file-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async path => { const workspace = { id: `w${workspaces.size + 1}`, path }; workspaces.set(workspace.id, workspace); return workspace },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // The bytes endpoint answers the request itself, so its response is read raw.
  const openFile = payload => route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint: 'file-open', payload }) }))
  const tool = (name, args, sessionId, extra = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...extra })
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, openFile, tool, emit, stop, sent, ctx, rt }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  return { chief, writer, room }
}

// A working folder for the group, gone with the test.
function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

test('a file from the group folder posts into the group with its bytes stored once', async (t) => {
  const { call, tool, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const dir = workDir(t)
  await call('update-room', { id: room.id, workDir: dir })
  const store = fakeAttachments()
  rt.ctx.get = name => (name === 'attachments' ? store : undefined)
  writeFileSync(join(dir, 'report.docx'), 'docx-bytes')
  const out = await tool('send_file', { group: 'R1', path: join(dir, 'report.docx'), message: 'The report.' }, rt.chatOf(chief))
  assert.match(out, /^Sent "report\.docx" \(10 bytes\) into "R1"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.ok(post, 'the group Session gets the post')
  assert.equal(post.message.content[0].text, '[Group post from Chief]\nThe report.')
  const file = post.message.content.find(block => block.type === 'file')?.attachment
  assert.equal(file?.name, 'report.docx')
  assert.equal(file?.bytes, 10)
  // A delivered file is not a question: the post calls nobody, so no round starts.
  assert.equal(post.message.source.progress, true)
  assert.equal(post.message.source.length, undefined, 'no long-message file of its own')
  assert.equal(new TextDecoder().decode(store.files.get(file.attachmentId)), 'docx-bytes')
})

test('a member can send a file from its own group, and the log keeps the file with the line', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const dir = workDir(t)
  await call('update-room', { id: room.id, workDir: dir })
  const store = fakeAttachments()
  rt.ctx.get = name => (name === 'attachments' ? store : undefined)
  writeFileSync(join(dir, 'table.xls'), 'xls-bytes')
  const out = await tool('send_file', { group: 'R1', path: join(dir, 'table.xls') }, rt.chatOf(writer.id))
  assert.match(out, /^Sent "table\.xls"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.equal(post.message.content[0].text, '[Group post from Writer]\n', 'no message text is fine')
  const file = post.message.content.find(block => block.type === 'file')?.attachment

  // The relay turn writes the line the members read, and the file rides with it.
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await tool('group_relay', {}, room.id, { callId: 'relay' })
  const line = rt.state.rooms[room.id].log.find(entry => entry.botId === writer.id)
  assert.deepEqual(line.files, [file])
  assert.match(line.text, /\[File "table\.xls" \(9 bytes\) attached\]/)
})

test('a file outside the folders the group works in is refused with where it may sit', async (t) => {
  const { call, tool, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const dir = workDir(t)
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-out-'))
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5 }))
  await call('update-room', { id: room.id, workDir: dir })
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  const out = await tool('send_file', { group: 'R1', path: join(outside, 'secret.txt') }, rt.chatOf(chief))
  assert.match(out, /is outside the folders this group works in/)
  assert.ok(out.includes(dir.replace(/\\/g, '/')) || out.includes(dir), 'the message names the folder')
  assert.equal(sent.filter(entry => entry.sessionId === room.id).length, 0, 'nothing was posted')
})

test('a path that is not a file is refused before anything is read', async (t) => {
  const { call, tool, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const dir = workDir(t)
  await call('update-room', { id: room.id, workDir: dir })
  assert.match(await tool('send_file', { group: 'R1', path: join(dir, 'missing.txt') }, rt.chatOf(chief)), /There is no file at/)
  mkdirSync(join(dir, 'sub'))
  assert.match(await tool('send_file', { group: 'R1', path: join(dir, 'sub') }, rt.chatOf(chief)), /is not a file/)
  assert.match(await tool('send_file', { group: 'R1', path: '' }, rt.chatOf(chief)), /Give the path of the file/)
  assert.equal(sent.filter(entry => entry.sessionId === room.id).length, 0, 'nothing was posted')
})

test('a file past the size limit is refused by its size, not by reading it', async (t) => {
  const { call, tool, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const dir = workDir(t)
  await call('update-room', { id: room.id, workDir: dir })
  const big = join(dir, 'huge.bin')
  writeFileSync(big, '')
  // Sparse: the size is what the guard reads, so no 64 MB is ever allocated.
  truncateSync(big, GROUP_FILE_MAX + 1)
  const out = await tool('send_file', { group: 'R1', path: big }, rt.chatOf(chief))
  assert.match(out, new RegExp(`more than the ${GROUP_FILE_MAX} bytes`))
  assert.equal(sent.filter(entry => entry.sessionId === room.id).length, 0, 'nothing was posted')
})

test('a group with no folder to work in says so instead of sending nothing', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const { chief } = await team(call)
  const teamFolder = rt.teamFolder
  const workDirOf = rt.workDirOf
  rt.teamFolder = () => undefined
  rt.workDirOf = () => undefined
  const out = await tool('send_file', { group: 'R1', path: join(tmpdir(), 'any.txt') }, rt.chatOf(chief))
  rt.teamFolder = teamFolder
  rt.workDirOf = workDirOf
  assert.match(out, /works in no folder yet/)
})

test('the bytes endpoint answers a stored file as a download, and a refusal as JSON', async (t) => {
  const { openFile, stop, rt } = start()
  t.after(stop)
  const store = fakeAttachments()
  rt.ctx.get = name => (name === 'attachments' ? store : undefined)
  const saved = await store.saveFile({ data: new TextEncoder().encode('file-bytes'), name: '报告.docx' })
  const ok = await openFile({ file: saved })
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') ?? '', /application\/octet-stream/)
  assert.match(ok.headers.get('content-disposition') ?? '', /filename=".*"/)
  assert.match(ok.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)
  assert.equal(new TextDecoder().decode(new Uint8Array(await ok.arrayBuffer())), 'file-bytes')
  const missing = await openFile({ file: { attachmentId: 'sha256:nope', name: 'x' } })
  assert.equal(missing.status, 200)
  const body = await missing.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bot/unavailable')
  const unnamed = await openFile({})
  assert.equal((await unnamed.json()).error.code, 'bot/invalid')
})

test('resolveSendFile reads a path the way the group folder names one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-resolve-'))
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-base-'))
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-far-'))
  try {
    // realpath both sides: a temporary folder may sit behind a link, and the resolver
    // answers with the path DSH would work in.
    const realBase = realpathSync(base)
    writeFileSync(join(realBase, 'notes.md'), 'hi')
    const wanted = { path: join(realBase, 'notes.md'), name: 'notes.md', bytes: 2 }
    // A relative path names a file in the folder the Session works in.
    assert.deepEqual(await resolveSendFile('notes.md', { base: realBase, roots: [realBase] }), wanted)
    // An absolute path is taken as given.
    assert.deepEqual(await resolveSendFile(join(realBase, 'notes.md'), { base: undefined, roots: [realBase] }), wanted)
    // Quotes around a path are the shell's, not the file's.
    assert.deepEqual(await resolveSendFile(`"${join(realBase, 'notes.md')}"`, { base: realBase, roots: [realBase] }), wanted)
    assert.match((await resolveSendFile('', { base: realBase, roots: [dir] })).error, /Give the path/)
    assert.match((await resolveSendFile('gone.txt', { base: realBase, roots: [dir] })).error, /There is no file/)
    // "~" alone is the home folder, which is a directory, not a file.
    assert.match((await resolveSendFile('~', { base: realBase, roots: [homedir()] })).error, /is not a file/)
    writeFileSync(join(outside, 'far.txt'), 'x')
    const refused = await resolveSendFile(join(outside, 'far.txt'), { base: realBase, roots: [dir] })
    assert.match(refused.error, /is outside the folders/)
    assert.ok(refused.error.includes(realpathSync(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    rmSync(base, { recursive: true, force: true, maxRetries: 5 })
    rmSync(outside, { recursive: true, force: true, maxRetries: 5 })
  }
})
