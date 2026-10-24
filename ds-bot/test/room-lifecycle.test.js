import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { haltRoom, isRetired, resumeRoom, retireSessions, roomStatus, RETIRED_KEPT } from '../src/host/lifecycle.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// The lifecycle record: a room halts with a reason a reader can act on, a member
// already working waits instead of answering across rooms, and a session that
// wakes after its Bot was deleted is refused by name.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-life-'))
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
  const made = (await call('create-room', { name: 'R1', members: [chief, writer.id, reviewer.id] })).value
  // "everyone" answers a plain message in turn; the default sends it to the admin first.
  const updated = await call('update-room', { id: made.id, mode: 'everyone' })
  const room = updated.value?.room ?? made
  return { chief, writer, reviewer, room }
}

// A user's message reaches the room's Session; the relay turn runs the round.
async function userRound({ call, tool, emit, sent, rt }, room, text) {
  await emit(room.id, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
  await tool('group_relay', {}, room.id, { callId: `relay-${Math.random()}` })
}

test('a member still working in another chat waits, and the round goes on without it', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  // Writer is mid-turn in its own chat with the user.
  rt.live.set(rt.chatOf(writer.id), { turn: {} })
  assert.equal(rt.activeSessions(writer.id).idle, false, 'a live turn is not idle')
  await userRound({ call, tool, emit, sent, rt }, room, 'Hello everyone')
  const roundStart = rt.roomEventsOf(room.id).find(line => line.type === 'round.start')
  assert.deepEqual(roundStart.slots.map(slot => slot.name), ['Chief', 'Reviewer'], 'the working member is not called')
  assert.deepEqual(roundStart.standby, ['Writer'], 'it waits for a hand-off instead')
  const notice = (rt.state.rooms[room.id].log ?? []).map(line => line.text ?? '').find(text => /was still working/.test(text))
  assert.match(notice, /@Writer was still working in another chat/, 'the group is told why')
})

test("the admin's dispatch leaves a working member waiting too", async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  rt.live.set(rt.chatOf(writer.id), { turn: {} })
  await tool('post_to_group', { group: 'R1', message: '@Writer start the work @Reviewer check it after' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await tool('group_relay', {}, room.id, { callId: 'relay' })
  const roundStart = rt.roomEventsOf(room.id).find(line => line.type === 'round.start')
  assert.deepEqual(roundStart.slots, [], 'the only member the dispatch called is working')
  assert.deepEqual(roundStart.standby, ['Writer', 'Reviewer'], 'both wait')
})

// A member working in THIS room is the hand-off the round is built for: the
// message queues and its answer comes back late. Only work somewhere else - a
// private chat, another group - holds a member back.
test('a member working in this room is still called, so work hands on', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const here = 'writer-group-session'
  rt.state.rooms[room.id].sessions = { [writer.id]: here }
  rt.live.set(here, { turn: {} })
  assert.equal(rt.activeSessions(writer.id).running.length, 1, 'it works in this room')
  await userRound({ call, tool, emit, sent, rt }, room, 'Hello everyone')
  const roundStart = rt.roomEventsOf(room.id).find(line => line.type === 'round.start')
  assert.ok(roundStart.slots.some(slot => slot.name === 'Writer'), 'the working member is still called')
  assert.deepEqual(roundStart.standby, [], 'nobody waits')
})

test('a session that wakes after its Bot was deleted is refused by name', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const gone = rt.chatOf(writer.id)
  await call('delete-bot', { id: writer.id })
  assert.equal(rt.botOf(writer.id), undefined, 'the Bot is gone')
  assert.equal(isRetired(rt.state, gone), true, 'its sessions are on the deny-list')
  assert.equal(rt.state.retiredSessions[gone].name, 'Writer', 'the entry says which Bot it was')
  // A late answer it was still writing lands nowhere, and the group is told.
  const before = (rt.state.rooms[room.id].log ?? []).length
  await rt.lateRoomReply(gone, { roomId: room.id }, 'here is the work you asked for')
  assert.equal((rt.state.rooms[room.id].log ?? []).length, before, 'nothing is posted for it')
  const refused = rt.roomEventsOf(room.id).find(line => line.type === 'retired.refused')
  assert.ok(refused, 'the refusal is recorded')
  assert.equal(refused.name, 'Writer')
  // A session nobody retired is simply not a member any more, and says nothing.
  await rt.lateRoomReply('some-other-session', { roomId: room.id }, 'hello?')
  assert.equal(rt.roomEventsOf(room.id).filter(line => line.type === 'retired.refused').length, 1)
})

test('the lifecycle words are a vocabulary, not a convention', () => {
  const room = { id: 'r' }
  assert.equal(roomStatus(room), 'active')
  haltRoom(room, { kind: 'user', reason: 'the user stopped it' })
  assert.equal(roomStatus(room), 'halted')
  assert.equal(room.haltedKind, 'user')
  assert.equal(room.haltedReason, 'the user stopped it')
  resumeRoom(room, { reason: 'the user wrote here' })
  assert.equal(roomStatus(room), 'active')
  assert.equal(room.resumedReason, 'the user wrote here')
  assert.equal(room.lateRounds, 0)
  // The deny-list is bounded: the oldest entries are the ones dropped.
  const state = {}
  for (let index = 0; index < RETIRED_KEPT + 5; index++) retireSessions(state, [`s${index}`], `Bot ${index}`)
  assert.equal(Object.keys(state.retiredSessions).length, RETIRED_KEPT)
  assert.equal(state.retiredSessions.s0, undefined)
  assert.equal(state.retiredSessions[`s${RETIRED_KEPT + 4}`].name, `Bot ${RETIRED_KEPT + 4}`)
})
