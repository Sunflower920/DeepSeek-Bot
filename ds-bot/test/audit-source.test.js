import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { AUDITS_KEPT, digestOf } from '../src/host/audit.js'
import { fakeContext } from './fake-ctx.js'

// One source knows what was read: the prompt a member is shown each turn, the
// group chat it reads on request, and one cut line read by seq all land in
// state.audits with a digest of the text they were actually given.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-audit-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({}) },
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
  const tool = (name, args, sessionId, extra = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...extra })
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { call, tool, emit, stop, sent, rt }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const made = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  return { chief, writer, room: made }
}

const settle = async (ready, tries = 200) => {
  for (let index = 0; index < tries; index++) {
    if (await ready()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
// A line in the group's log, which is what the reads in these tests are about.
async function say({ tool, emit, sent, rt }, room, chief, text) {
  await tool('post_to_group', { group: 'R1', message: text }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const stop = new AbortController()
  const before = rt.roomEventsOf(room.id).length
  void tool('group_relay', {}, room.id, { callId: `relay-${Math.random()}`, signal: stop.signal }).catch(() => {})
  await settle(() => rt.roomEventsOf(room.id).length > before + 1)
  stop.abort()
  await settle(() => true)
}

test('a bot reading the group chat is on record, with a digest of what it saw', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  await say({ tool, emit, sent, rt }, room, chief, 'the first line of the group')
  await tool('read_group_chat', { group: 'R1' }, rt.chatOf(writer.id))
  // The relay that ran above recorded a prompt read too - both are reads of the
  // same record, which is the point: one source for all of them.
  const audits = (rt.state.audits ?? []).filter(item => item.kind === 'chat')
  assert.equal(audits.length, 1, 'the chat read is recorded')
  const [entry] = audits
  assert.equal(entry.roomId, room.id)
  assert.equal(entry.botId, writer.id, 'by the reader')
  assert.equal(entry.kind, 'chat')
  assert.equal(entry.digest.length, 16, 'a digest of the text it was shown')
  assert.ok(entry.chars > 0)
})

test('reading one cut line records that line and its digest', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  await say({ tool, emit, sent, rt }, room, chief, 'a very long line that a member will read by its seq later')
  const line = rt.state.rooms[room.id].log.at(-1)
  const shown = await tool('read_group_chat', { group: 'R1', seq: line.seq }, rt.chatOf(writer.id))
  const entry = (rt.state.audits ?? []).find(item => item.kind === 'line')
  assert.ok(entry, 'the line read is recorded')
  assert.equal(entry.seq, line.seq)
  assert.equal(entry.digest, digestOf(shown), 'the digest is of the text it was shown, prefix and all')
  // The same span can be looked up later, which is how a claim is checked.
  assert.equal(rt.digestFor(room.id, line.seq), entry.digest)
})

test('the prompt a member is shown each turn goes through the same source', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  // A round with a speaker: the prompt is built and recorded before the member
  // answers, so the relay is started and released rather than waited out.
  await tool('post_to_group', { group: 'R1', message: '@Writer look at this' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const stopper = new AbortController()
  void tool('group_relay', {}, room.id, { callId: 'relay-audit', signal: stopper.signal }).catch(() => {})
  await settle(() => (rt.state.audits ?? []).some(item => item.kind === 'prompt'))
  stopper.abort()
  await settle(() => true)
  const entry = (rt.state.audits ?? []).find(item => item.kind === 'prompt')
  assert.ok(entry, 'the prompt read is recorded')
  assert.equal(entry.botId, writer.id)
  assert.equal(entry.roomId, room.id)
  assert.ok(entry.chars > 0, 'and it is the whole prompt, not a marker')
})

test('the audit is a ring, and a digest says what the text really was', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  for (let index = 0; index < AUDITS_KEPT + 30; index++) {
    rt.auditRead({ roomId: room.id, botId: writer.id, kind: 'chat', text: `read number ${index}` })
  }
  assert.equal((rt.state.audits ?? []).length, AUDITS_KEPT, 'the oldest reads fall out')
  assert.match(String(rt.state.audits.at(-1).text ?? rt.state.audits.at(-1).digest), /./)
  // The digest is stable for the same text and different for other text: that
  // difference is what makes "the draft changed" a fact and not an argument.
  assert.equal(digestOf('the deliverable, version 3'), digestOf('the deliverable, version 3'))
  assert.notEqual(digestOf('the deliverable, version 3'), digestOf('the deliverable, version 4'))
})
