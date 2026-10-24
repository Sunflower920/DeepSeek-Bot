import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A dispatch names the member that starts and the ones that follow it. On 2026-10-23
// the admin's dispatch woke both the developer and the code reviewer, so the reviewer
// began its own review while the developer was still working; one task took hours.
// Only the first named member is called now, the rest wait for the hand-off, and the
// group is told when a round ends without one.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dispatch-'))
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
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  // The group's relay turn, with the inbox the round drains.
  const relay = (roomId, callId) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: { nextTurn: [], nextStep: [] } }, callId, signal: new AbortController().signal })
  // The Bot's answer to its group turn: a delivery source plus the reply text.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, emit, userMessage, relay, answer, stop, sent, ctx, rt }
}

// A three-Bot pipeline like the group the report came from: the admin dispatches,
// the developer implements, the reviewer reviews.
async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const dev = (await call('create-bot', { name: 'Dev' })).value
  const reviewer = (await call('create-bot', { name: 'Reviewer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, dev.id, reviewer.id] })).value
  return { chief, dev, reviewer, room }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
// The next group turn delivered to a member, after the ones already taken.
const nextTurn = async (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))
// The member a group turn was delivered to, read off the room's Sessions.
const speakerOf = (rt, roomId, sessionId) => Object.entries(rt.state.rooms[roomId].sessions ?? {}).find(([, id]) => id === sessionId)?.[0]
const turnsFor = (sent, ...earlier) => sent.filter(entry => !earlier.includes(entry) && entry.message.source.role === 'room')

test('a dispatch into the group calls the first member it names; the named reviewer waits', async (t) => {
  const { call, tool, emit, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const { chief, dev, reviewer, room } = await team(call)

  // The admin posts the dispatch from its own chat, as post_to_group does.
  // One worker named here, so the work starts at once: the reviewer is named
  // later, in the developer's hand-off, which is what this test is about. A
  // dispatch naming both up front would stage a plan first.
  await tool('post_to_group', { group: 'R1', message: '@Dev 派单，请改这三处。改完发版本公告，然后交给审查。' }, rt.chatOf(chief))
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const running = relay(room.id, 'dispatch')

  const first = await nextTurn(sent)
  assert.equal(speakerOf(rt, room.id, first.sessionId), dev.id, 'the developer is called')
  assert.match(first.message.content[0].text, /the group was just created|Speaking order|This round so far/)
  // The reviewer was named for the next step but is not called: no turn of its own.
  const reviewerSession = () => Object.values(rt.state.rooms[room.id].sessions ?? {}).find(id => id !== first.sessionId && sent.some(entry => entry.sessionId === id && entry.message.source.role === 'room'))
  assert.equal(reviewerSession(), undefined, 'the reviewer gets no turn in this round')

  // The developer hands off with "@Reviewer"; the reviewer now starts, and its
  // prompt carries the developer's result, which is what it was waiting for.
  await answer(first.sessionId, first.message.source.exchangeId, '改完了，版本公告如下。@Reviewer 请审查。', 1)
  const second = await nextTurn(sent, first)
  assert.equal(speakerOf(rt, room.id, second.sessionId), reviewer.id, 'the hand-off calls the reviewer')
  assert.match(second.message.content[0].text, /改完了，版本公告如下/)
  await answer(second.sessionId, second.message.source.exchangeId, '审查通过，放行。@Dev 无必修项。', 2)
  const third = await nextTurn(sent, first, second)
  assert.equal(speakerOf(rt, room.id, third.sessionId), dev.id, 'the hand-off chain goes on')
  await answer(third.sessionId, third.message.source.exchangeId, '收到。', 3)
  await running

  // The hand-off reached the reviewer, so the round says nothing about it.
  assert.equal((rt.state.rooms[room.id].log ?? []).some(line => line.kind === 'notice' && /was named for a later step/.test(line.text)), false)
})

test('a round that ends without the hand-off tells the group who was left waiting', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const { dev, room } = await team(call)

  // The user writes plainly: in admin mode the admin answers first and dispatches.
  await emit(room.id, userMessage('把这三处改掉'))
  const running = relay(room.id, 'round')
  const chiefTurn = await nextTurn(sent)
  assert.equal(speakerOf(rt, room.id, chiefTurn.sessionId), (await call('state', {})).value.mainBotId)
  // The dispatch names the developer to start and the reviewer for the next step.
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, '@Dev 派单，只改这三处。@Reviewer 待命，等 Dev 确认后再审。', 1)

  const devTurn = await nextTurn(sent, chiefTurn)
  assert.equal(speakerOf(rt, room.id, devTurn.sessionId), dev.id, 'only the developer is called')
  const called = turnsFor(sent, chiefTurn, devTurn)
  assert.equal(called.length, 0, 'the reviewer was not called while the developer works')

  // The developer finishes without handing off; the round ends with the reviewer
  // still named for the next step, so the group is told instead of staying silent.
  await answer(devTurn.sessionId, devTurn.message.source.exchangeId, '改完了，自验通过。', 2)
  await running
  const notice = (rt.state.rooms[room.id].log ?? []).find(line => line.kind === 'notice' && /was named for a later step/.test(line.text))
  assert.ok(notice, 'the group is told the hand-off is missing')
  assert.match(notice.text, /@Reviewer was named for a later step but was not called/)
})

test("the user's own message still calls every member it names", async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const { dev, reviewer, room } = await team(call)

  await emit(room.id, userMessage('@Dev 看一下X @Reviewer 看一下Y'))
  const running = relay(room.id, 'user-both')
  const first = await nextTurn(sent)
  assert.equal(speakerOf(rt, room.id, first.sessionId), dev.id, 'the first named member answers first')
  await answer(first.sessionId, first.message.source.exchangeId, 'X看完了。', 1)
  const second = await nextTurn(sent, first)
  assert.equal(speakerOf(rt, room.id, second.sessionId), reviewer.id, 'the second named member answers too')
  await answer(second.sessionId, second.message.source.exchangeId, 'Y看完了。', 2)
  await running
})

test('the admin calling everyone with @all still wakes every member', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const { dev, reviewer, room } = await team(call)

  await emit(room.id, userMessage('都说说进度'))
  const running = relay(room.id, 'all')
  const chiefTurn = await nextTurn(sent)
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, '@all 各自汇报当前进度。', 1)
  // Members speak one at a time, so each is answered before the next is waited for.
  const first = await nextTurn(sent, chiefTurn)
  await answer(first.sessionId, first.message.source.exchangeId, 'Dev：改完了。', 2)
  const second = await nextTurn(sent, chiefTurn, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Reviewer：审完了。', 3)
  await running
  assert.equal(speakerOf(rt, room.id, first.sessionId), dev.id, 'the first member answers')
  assert.equal(speakerOf(rt, room.id, second.sessionId), reviewer.id, 'and so does the second')
})

test("a member's hand-off to two members still calls both", async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const { chief, dev, reviewer, room } = await team(call)

  await emit(room.id, userMessage('开工'))
  const running = relay(room.id, 'handoff')
  const chiefTurn = await nextTurn(sent)
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, '@Dev 你来改这三处。', 1)
  const devTurn = await nextTurn(sent, chiefTurn)
  assert.equal(speakerOf(rt, room.id, devTurn.sessionId), dev.id)
  // The developer hands the review on and sends the chief back to the user: a
  // member's hand-off is not a dispatch, so both are called, one at a time.
  await answer(devTurn.sessionId, devTurn.message.source.exchangeId, '改完了。@Reviewer 请审查；@Chief 汇报时引用这条公告。', 2)
  const first = await nextTurn(sent, chiefTurn, devTurn)
  await answer(first.sessionId, first.message.source.exchangeId, '审查通过。', 3)
  const second = await nextTurn(sent, chiefTurn, devTurn, first)
  await answer(second.sessionId, second.message.source.exchangeId, '我来汇报。', 4)
  await running
  assert.equal(speakerOf(rt, room.id, first.sessionId), reviewer.id, 'the review is called')
  assert.equal(speakerOf(rt, room.id, second.sessionId), chief, 'and so is the chief')
})
