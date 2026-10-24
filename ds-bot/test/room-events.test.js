import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { EVENT_RING } from '../src/host/events.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// The group's lifecycle record: round shape, drops, quiet notices. The ring is
// bounded, the sequence is per room and monotonic, and a panel passing the last
// sequence it saw gets only what is new.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-events-'))
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
  const tool = (name, args, sessionId, extra = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...extra })
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, emit, stop, sent, rt }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reviewer = (await call('create-bot', { name: 'Reviewer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id, reviewer.id] })).value
  return { chief, writer, reviewer, room }
}

function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-events-work-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

// A post reaches the room's Session; the relay turn it triggers runs the round.
// The fake Session answers nothing, so the round ends with no replies.
async function relayRound(t, { call, tool, emit, stop, rt }, post) {
  const room = rt.roomOf(post.sessionId)
  await emit(post.sessionId, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await tool('group_relay', {}, post.sessionId, { callId: 'relay' })
  return room
}

test('a round records its shape: who speaks, in what order, who waits', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const dir = workDir(t)
  await call('update-room', { id: room.id, workDir: dir })
  const store = fakeAttachments()
  rt.ctx.get = name => (name === 'attachments' ? store : undefined)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.txt'), 'hello')
  await tool('send_file', { group: 'R1', path: join(dir, 'report.txt'), message: '@Writer please read it' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.ok(post, 'the file posts into the group')
  await relayRound(t, { call, tool, emit, stop, rt }, post)
  const events = rt.roomEventsOf(room.id)
  const roundStart = events.find(line => line.type === 'round.start')
  assert.ok(roundStart, 'the round start is recorded')
  assert.deepEqual(roundStart.slots.map(slot => slot.name), ['Writer'], 'the member the post named speaks')
  assert.deepEqual(roundStart.standby, [], 'nobody waits when one member is named')
  assert.ok(roundStart.seq >= 1, 'the event carries its sequence')
  // A panel that saw the start gets only later events.
  assert.ok(rt.roomEventsOf(room.id, roundStart.seq).every(line => line.seq > roundStart.seq))
  const roundEnd = events.find(line => line.type === 'round.end')
  assert.ok(roundEnd, 'the round end is recorded')
  assert.equal(typeof roundEnd.replies, 'number')
})

test("the admin's dispatch names the starter and leaves the rest waiting, and the event says so", async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  // One worker named: the work starts at once and the rest wait for the
  // hand-off. Two or more would stage a plan instead (see room-lifecycle).
  await tool('post_to_group', { group: 'R1', message: '@Writer start the work' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.ok(post, 'the dispatch posts into the group')
  await relayRound(t, { call, tool, emit, stop, rt }, post)
  const roundStart = rt.roomEventsOf(room.id).find(line => line.type === 'round.start')
  assert.deepEqual(roundStart.slots.map(slot => slot.name), ['Writer'], 'only the first named member is called')
  assert.deepEqual(roundStart.standby, [], 'nobody else was named')
})

test('the events ring keeps a room recent, not everything it ever ran', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const { room } = await team(call)
  assert.equal(EVENT_RING, 200)
  for (let index = 0; index < EVENT_RING + 40; index++) rt.emitEvent(room.id, 'quiet', { index })
  const events = rt.state.rooms[room.id].events
  assert.equal(events.length, EVENT_RING, 'the ring is bounded')
  assert.equal(events[0].index, 40, 'the oldest events are the ones dropped')
  assert.equal(rt.state.rooms[room.id].eventSeq, EVENT_RING + 40, 'the sequence keeps counting past the ring')
})

test('the room-events endpoint answers with a cursor', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const { room } = await team(call)
  rt.emitEvent(room.id, 'quiet', { limit: 10 })
  const first = await call('room-events', { roomId: room.id })
  assert.equal(first.ok, true)
  assert.equal(first.value.events.length, 1)
  assert.equal(first.value.events[0].type, 'quiet')
  const again = await call('room-events', { roomId: room.id, since: first.value.seq })
  assert.deepEqual(again.value.events, [], 'a cursor that saw everything gets nothing new')
  assert.equal(again.value.seq, first.value.seq)
  const unknown = await call('room-events', { roomId: 'nope' })
  assert.deepEqual(unknown.value.events, [], 'an unknown room has no events')
})

test('a second spelling of a live name is refused, and the loose spelling still resolves', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const { chief } = await team(call)
  // "Dev Lead" is taken; "dev-lead" and "devlead" are the same name to a reader.
  const devLead = (await call('create-bot', { name: 'Dev Lead' })).value
  const clash = await call('create-bot', { name: 'dev-lead' })
  assert.equal(clash.ok, false)
  assert.match(clash.error.message, /the same name as "Dev Lead", spelled differently/)
  assert.equal(rt.findBot('devlead').id, devLead.id, 'a mention written with the other spelling resolves')
  assert.equal(rt.findBot('DEV-LEAD').id, devLead.id)
  // Renaming onto another Bot's spelling is refused the same way.
  const rename = await call('update-bot', { id: chief, name: 'dev.lead' })
  assert.equal(rename.ok, false)
  assert.match(rename.error.message, /not available/)
})

test('a group name keeps one spelling too', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const { chief, writer, reviewer } = await team(call)
  const first = await call('create-room', { name: 'Dev Room', members: [chief, writer.id] })
  assert.equal(first.ok, true)
  const clash = await call('create-room', { name: 'dev-room', members: [chief, reviewer.id] })
  assert.equal(clash.ok, false)
  assert.match(clash.error.message, /the same name as "Dev Room", spelled differently/)
  // The loose spelling resolves to the one that exists.
  const found = await call('update-room', { id: first.value.id, name: 'DEVROOM' })
  assert.equal(found.ok, true)
})
