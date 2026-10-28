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
  // One worker named: that dispatch still starts work directly, so the busy
  // rule is what holds the member back - two or more would stage a plan.
  await tool('post_to_group', { group: 'R1', message: '@Writer start the work' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await tool('group_relay', {}, room.id, { callId: 'relay' })
  const roundStart = rt.roomEventsOf(room.id).find(line => line.type === 'round.start')
  assert.deepEqual(roundStart.slots, [], 'the only member the dispatch called is working')
  assert.deepEqual(roundStart.standby, ['Writer'], 'it waits instead')
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
  assert.match(promptFor(sent, sessionId), /本轮只求一个“收到”.*this round asks for an acknowledgement only/, '提示词中文示人、英文标记仍在（网关靠它识别）')
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

// ── #7 staged plan: work is agreed before it starts ───────────────────────────

// An admin's dispatch naming two or more workers stages a plan instead of
// starting them at once; the work begins when the plan is approved.
async function dispatchVia({ tool, emit, sent, rt }, room, chief, text) {
  await tool('post_to_group', { group: room.name, message: text }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  // The round's shape is what these tests read, and it is recorded before any
  // member is called - so the relay is started and released, not waited out.
  const stop = new AbortController()
  const before = rt.roomEventsOf(room.id).length
  void tool('group_relay', {}, room.id, { callId: `relay-${Math.random()}`, signal: stop.signal }).catch(() => {})
  await settle(() => rt.roomEventsOf(room.id).length > before + 1)
  stop.abort()
  await settle(() => true)
}

test('a dispatch naming two workers stages a plan and starts nobody', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  const plans = Object.values(rt.state.plans ?? {})
  assert.equal(plans.length, 1, 'the dispatch became a plan')
  const plan = plans[0]
  assert.equal(plan.status, 'draft')
  assert.deepEqual(plan.steps.map(step => step.name), ['Writer', 'Reviewer'], 'in the order they were named')
  // Each step carries the words aimed at that member - the segment between
  // their own @name and the next one - not a copy of the whole dispatch.
  assert.deepEqual(plan.steps.map(step => step.task), ['先写实现', '写完审查'], 'each step reads as its own instruction')
  assert.equal(plan.by, chief)
  const staged = rt.roomEventsOf(room.id).find(line => line.type === 'plan.staged')
  assert.ok(staged, 'the staging is recorded')
  const round = rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1)
  assert.deepEqual(round.slots, [], 'nobody was called')
})

test('a step\'s task is the segment between its own mention and the next', async (t) => {
  // The segment rule, and its edges: a preamble belongs to nobody, a member
  // named with no words of their own inherits the shared instruction, and a
  // short name never matches inside a longer one.
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '请各位准备：@Writer 先写实现 @Reviewer 写完审查')
  const plan = Object.values(rt.state.plans)[0]
  assert.deepEqual(plan.steps.map(step => step.task), ['先写实现', '写完审查'], 'the preamble belongs to nobody')
  // A second dispatch restates it; the words are re-split the same way.
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Reviewer 先审 @Writer 再改')
  const revised = Object.values(rt.state.plans)[0]
  assert.deepEqual(revised.steps.map(step => [step.name, step.task]), [['Reviewer', '先审'], ['Writer', '再改']])
  // A member named with nothing between the mentions takes the shared text.
  await call('create-bot', { name: 'Tester' })
  await call('update-room', { id: room.id, add: [Object.values(rt.state.bots).find(bot => bot.name === 'Tester').id] })
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 改 @Tester @Reviewer 审')
  const shared = Object.values(rt.state.plans)[0]
  const tester = shared.steps.find(step => step.name === 'Tester')
  assert.equal(tester.task, '改 审', 'the empty segment falls back to the shared instruction')
})

test('the work starts when the plan is approved, and not when it is sent back', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  // A rejection leaves the work undone.
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '不行，改一下方案')
  assert.equal(Object.values(rt.state.plans)[0].status, 'rejected')
  assert.deepEqual(rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1).slots, [], 'still nobody')
  // A fresh plan, then approval: this time the first worker is called.
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '同意，开始干')
  const plan = Object.values(rt.state.plans).find(item => item.status !== 'rejected')
  assert.equal(plan.status, 'running', 'approval started the work')
  assert.equal(plan.approvedBy, chief)
  const round = rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1)
  assert.deepEqual(round.slots.map(slot => slot.name), ['Writer'], 'the plan\'s first step was called')
  assert.deepEqual(round.standby, ['Reviewer'], 'and the second waits for its hand-off')
})

test('the worker holding a step is told the plan and whom to hand off to', async (t) => {
  // A worker that is not told it holds step N of an agreed plan finishes its
  // part and stops: the next step waits for a hand-off nobody asked for (live
  // 2026-10-25 21:17 - the developer repacked the zip and never named the
  // reviewer). The prompt carries the plan, the worker's own step, and the
  // name it must hand off to.
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  // The admin's approval arrives as a post; the round is started afterwards so
  // it can be read at the worker's prompt.
  await tool('post_to_group', { group: room.name, message: '同意，开始干' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const sessionId = await drivenRound({ tool, emit, sent, rt }, room, writer.id, '写好了')
  assert.ok(sessionId !== undefined, 'the writer was called')
  const prompt = promptFor(sent, sessionId)
  assert.match(prompt, /The group approved this plan, in order: 1\. Writer — 先写实现; 2\. Reviewer — 写完审查/, 'the plan reaches the worker')
  assert.match(prompt, /You hold step 1: 先写实现/, 'its own step is named')
  assert.match(prompt, /hand off by naming @Reviewer/, 'and the hand-off target by name')
})

test('a plan stays running until its last step answers, so the later step still gets it', async (t) => {
  // A plan spans several rounds, but the plan used to be closed at the end of
  // ANY round - so only step 1 ever saw the plan note, and step 2 ran with no
  // idea it was part of an agreed plan (live 2026-10-28: the developer worked
  // 25 minutes while the plan had been finished 14 seconds in). Control: with
  // the old rule the first assertion below fails, because one answer closed it.
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  await tool('post_to_group', { group: room.name, message: '同意，开始干' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })

  const writerSession = await drivenRound({ tool, emit, sent, rt }, room, writer.id, '写好了，等审查')
  assert.ok(writerSession !== undefined, 'the first step was called')
  const afterFirst = Object.values(rt.state.plans)[0]
  assert.equal(afterFirst.status, 'running', 'one step answering does not finish a two-step plan')
  assert.equal(afterFirst.finishedAt, undefined, 'and no finish time is invented for it')

  // The second step's turn comes later. It still gets the plan note - that is
  // the entire reason the plan must stay running.
  // The second step's turn comes later, opened by the admin naming just that
  // member (a user message in an "everyone" room would call all three, and the
  // reviewer speaks last, so the test would drive the wrong turn).
  await tool('post_to_group', { group: room.name, message: '@Reviewer 请审查' }, rt.chatOf(chief))
  const reviewPost = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: reviewPost.message.source, content: reviewPost.message.content } })
  const reviewerSession = await drivenRound({ tool, emit, sent, rt }, room, reviewer.id, '审查通过')
  assert.ok(reviewerSession !== undefined, 'the reviewer was called')
  assert.match(promptFor(sent, reviewerSession), /You hold the last step \(2\)/, 'the last step is told it is the last')
  assert.equal(Object.values(rt.state.plans)[0].status, 'done', 'the last step is what finishes the plan')
})

test('a plan whose last step has not answered is never marked finished', async (t) => {
  // The other half of the same rule: a round that ends without the final
  // member's answer (it was busy, it failed, it never came) must not close the
  // plan either. Otherwise the note disappears for exactly the step still owed.
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '同意，开始干')
  // Nobody answers at all: dispatchVia aborts the relay, so the round ends with
  // an empty reply list - which is what a stuck or busy worker looks like.
  const plan = Object.values(rt.state.plans)[0]
  assert.equal(plan.status, 'running', 'an empty round does not finish the plan')
})

test('a dispatch naming one worker still starts at once', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 只改这一处')
  assert.equal(Object.keys(rt.state.plans ?? {}).length, 0, 'a single worker needs no plan')
  const round = rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1)
  assert.deepEqual(round.slots.map(slot => slot.name), ['Writer'], 'and is called straight away')
})

test('restating a plan before approval keeps the old shape on record', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  const first = Object.values(rt.state.plans)[0]
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Reviewer 先看规范 @Writer 再改实现')
  assert.equal(Object.keys(rt.state.plans).length, 1, 'the same plan was restated')
  assert.deepEqual(first.steps.map(step => step.name), ['Reviewer', 'Writer'], 'the new order')
  assert.equal(first.revisions.length, 1, 'the old shape is on record')
  assert.deepEqual(first.revisions[0].steps.map(step => step.name), ['Writer', 'Reviewer'], 'as it was before')
  assert.equal(first.status, 'draft', 'and it still waits for approval')
})

test('approve_plan does what the group\'s word does', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, writer, reviewer, room } = await team(call)
  await dispatchVia({ tool, emit, sent, rt }, room, chief, '@Writer 先写实现 @Reviewer 写完审查')
  const said = await tool('approve_plan', { group: 'R1', approve: true, reason: 'the user asked for it' }, rt.chatOf(chief))
  assert.match(said, /已批准/, '工具报告了批准')
  const plan = Object.values(rt.state.plans)[0]
  assert.equal(plan.status, 'running')
  assert.equal(plan.approvedReason, 'the user asked for it')
})
