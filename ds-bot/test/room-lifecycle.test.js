import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { ROOM_LATE_ROUNDS } from '../src/host/constants.js'
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

// ── #2 halted / resumed ───────────────────────────────────────────────────────

test('the late-round limit halts the group, and the user writing here resumes it', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  // The members' group Sessions, the way the host makes them: a late reply
  // arrives on one of those, not on a Bot's own chat.
  const late = (await rt.groupSessionFor(rt.state.rooms[room.id], rt.botOf(writer.id))).id
  // Late replies, one per round: the limit halts the group on the reply past it.
  for (let index = 0; index <= ROOM_LATE_ROUNDS; index++) {
    await rt.lateRoomReply(late, { roomId: room.id, askedBy: rt.state.rooms[room.id].admin }, 'done with the work')
  }
  const saved = rt.state.rooms[room.id]
  assert.equal(rt.isHalted(saved), true, 'the limit halts the group')
  assert.equal(saved.haltedKind, 'late-rounds', 'the reason is the loop, not a decision')
  const halted = rt.roomEventsOf(room.id).find(line => line.type === 'halted')
  assert.ok(halted, 'the halt is recorded')
  assert.equal(halted.kind, 'late-rounds')
  // A member's post into a halted group keeps its place but calls nobody.
  const before = (saved.log ?? []).length
  await tool('post_to_group', { group: 'R1', message: '@Writer look at this' }, rt.chatOf(rt.state.rooms[room.id].members[1]))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await tool('group_relay', {}, room.id, { callId: 'relay-halted' })
  assert.equal((saved.log ?? []).length, before + 1, 'the post reaches the log')
  const quietRound = rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1)
  assert.deepEqual(quietRound.slots, [], 'but nobody is called')
  // The user writing here resumes it, and the record says what lifted the halt.
  await userRound({ call, tool, emit, sent, rt }, room, 'carry on')
  assert.equal(rt.isHalted(rt.state.rooms[room.id]), false, 'the user message resumes the group')
  const resumed = rt.roomEventsOf(room.id).find(line => line.type === 'resumed')
  assert.ok(resumed, 'the resume is recorded')
  assert.equal(resumed.reason, 'the user wrote here')
})

test('a halt and a resume are decisions with reasons, taken through update_group', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  const halted = await tool('update_group', { group: 'R1', status: 'halted', reason: 'the user asked for quiet' }, rt.chatOf(chief))
  assert.match(halted, /stopped the group/, 'the halt reports itself')
  assert.equal(rt.state.rooms[room.id].haltedKind, 'user', 'a decision reads differently from the limit')
  // A resume without a reason is refused: a deliberate restart says why.
  const noReason = await tool('update_group', { group: 'R1', status: 'active' }, rt.chatOf(chief))
  assert.match(noReason, /Could not update/, 'a resume without a reason is refused')
  assert.equal(rt.isHalted(rt.state.rooms[room.id]), true, 'and the group stays halted')
  // The user's quiet is the user's to lift: a Bot serving its next request is
  // refused, and told where the resume really lives.
  const byBot = await tool('update_group', { group: 'R1', status: 'active', reason: 'the user is back' }, rt.chatOf(chief))
  assert.match(byBot, /Could not update.*only the user writing in the group/, 'a Bot cannot lift the user\'s halt')
  assert.equal(rt.isHalted(rt.state.rooms[room.id]), true, 'and the group stays halted')
  // The user's own message resumes it, with the reason recorded.
  await userRound({ call, tool, emit, sent, rt }, room, 'carry on')
  assert.equal(rt.isHalted(rt.state.rooms[room.id]), false, 'the user message resumes the group')
  assert.equal(rt.state.rooms[room.id].resumedReason, 'the user wrote here')
})

test('a halt the late-round limit caused is nobody\'s decision, so a Bot may lift it', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  const late = (await rt.groupSessionFor(rt.state.rooms[room.id], rt.botOf(writer.id))).id
  for (let index = 0; index <= ROOM_LATE_ROUNDS; index++) {
    await rt.lateRoomReply(late, { roomId: room.id, askedBy: rt.state.rooms[room.id].admin }, 'done with the work')
  }
  assert.equal(rt.state.rooms[room.id].haltedKind, 'late-rounds', 'the limit halted it')
  const resumed = await tool('update_group', { group: 'R1', status: 'active', reason: 'the work is finished' }, rt.chatOf(chief))
  assert.match(resumed, /resumed the group/, 'a Bot may lift this halt, with its reason')
  assert.equal(rt.state.rooms[room.id].resumedReason, 'the work is finished')
})

// ── #3 stopping is two stages ─────────────────────────────────────────────────

test('a stop cancels the turn and then waits for it to go quiet', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const { chief, writer } = await team(call)
  const here = rt.chatOf(writer.id)
  // A turn that ends on its own a little later: the cancel is the first stage,
  // the wait is the second.
  let entry = { turn: {} }
  rt.live.set(here, entry)
  const finish = setTimeout(() => rt.live.delete(here), 300)
  const { converged, still } = await rt.convergeSessions([here, rt.chatOf(chief)], { timeoutMs: 5000 })
  clearTimeout(finish)
  assert.deepEqual(converged, [here, rt.chatOf(chief)], 'both went quiet')
  assert.deepEqual(still, [], 'nothing is still writing')
  // A session that never quiets is reported, not waited on forever.
  rt.live.set(here, { turn: {} })
  const stuck = await rt.convergeSessions([here], { timeoutMs: 250 })
  assert.deepEqual(stuck.still, [here], 'the stuck session is reported')
  rt.live.delete(here)
})

// ── #11 a deleted group is archived, not erased ───────────────────────────────

test('a deleted group stays readable after the delete', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await userRound({ call, tool, emit, sent, rt }, room, 'hello everyone')
  await tool('delete_group', { group: 'R1' }, rt.chatOf(chief))
  assert.equal(rt.roomOf(room.id), undefined, 'the group is gone from the team')
  const archived = rt.state.archivedRooms[room.id]
  assert.ok(archived, 'but it is in the archive')
  assert.equal(archived.name, 'R1')
  assert.deepEqual(archived.memberNames, ['Chief', 'Writer', 'Reviewer'], 'the members are frozen by name')
  assert.equal(typeof archived.archivedAt, 'number')
  // A restart reads the archive from state: this is the cold discovery.
  const seen = (await call('state', {})).value.archivedRooms
  assert.equal(seen.length, 1)
  assert.equal(seen[0].id, room.id)
  assert.equal(seen[0].name, 'R1')
  assert.deepEqual(seen[0].memberNames, ['Chief', 'Writer', 'Reviewer'])
})

// A group round states its intent in the prompt: the gateway's closing-directive
// test cannot see a directive quoted inside a long round prompt (live 2026-10-25
// 00:29: "只回复一个收到" rotated twice on the reply "收到" and died at the
// budget), so the round says it in one line the gateway reads.
const settle = async (ready, tries = 200) => {
  for (let index = 0; index < tries; index++) {
    if (await ready()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
const promptFor = (sent, sessionId) => {
  const entry = [...sent].reverse().find(item => item.sessionId === sessionId)
  return entry?.message?.content?.find(block => block.type === 'text')?.text ?? ''
}
// Runs a round to its end: the relay starts, the member's turn is delivered, the
// member answers, the round concludes. Returns the member's group Session id.
async function drivenRound({ tool, emit, sent, rt }, room, memberId, answer) {
  const stop = new AbortController()
  let result
  void tool('group_relay', {}, room.id, { callId: `relay-${Math.random()}`, signal: stop.signal }).then(value => { result = value })
  const sessionId = await settle(async () => {
    const id = rt.state.rooms[room.id].sessions?.[memberId]
    return id !== undefined && promptFor(sent, id) !== ''
  }) ? rt.state.rooms[room.id].sessions[memberId] : undefined
  if (sessionId === undefined) return undefined
  await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } })
  await emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(() => result !== undefined)
  stop.abort()
  return sessionId
}

test('a round that asks only for an acknowledgement says so in the prompt', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  await tool('post_to_group', { group: 'R1', message: '@Writer 只回复一个「收到」，不要做其他任何操作' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const sessionId = await drivenRound({ tool, emit, sent, rt }, room, writer.id, '收到')
  assert.ok(sessionId, 'the member was called')
  assert.match(promptFor(sent, sessionId), /this round asks for an acknowledgement only/, 'the round states its intent')
})

test('a round that asks for work says nothing of the sort', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  await tool('post_to_group', { group: 'R1', message: '@Writer 帮忙核一下这个交付包' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const sessionId = await drivenRound({ tool, emit, sent, rt }, room, writer.id, '核完了，十条都对得上。')
  assert.ok(sessionId, 'the member was called')
  assert.doesNotMatch(promptFor(sent, sessionId), /acknowledgement only/, 'a work round carries no such note')
})
