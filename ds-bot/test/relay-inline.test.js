import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The relay runs inside the group's own stream rather than as a call handed to
// the agent loop: this host's scheduled-execution path logs without its inject
// and takes the round down before ds-bot runs (live 2026-10-25 14:16). This
// drives the llm/stream hook the way the host does and watches what it yields.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-inline-'))
  const ctx = fakeContext()
  const sent = []
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek' }], listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async id => ({ agent: { session: { id }, followup: message => sent.push({ sessionId: id, message }) } }),
      selectModel: async () => {}, page: async () => ({ events: [] }),
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
  return { call, tool, emit, stop, sent, ctx, rt }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const dev = (await call('create-bot', { name: 'Dev' })).value
  const reviewer = (await call('create-bot', { name: 'Reviewer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, dev.id, reviewer.id] })).value
  return { chief, dev, reviewer, room }
}

// A stream on the group's own Session, driven the way the host drives it.
async function streamGroup(rt, roomId, messages) {
  const hook = rt.ctx.listeners.get('llm/stream')?.at(0)
  assert.ok(hook, 'the relay hook is registered')
  const produced = []
  const generator = hook({ sessionId: roomId, messages }, function* pass() { yield* pass() })
  for await (const chunk of generator) produced.push(chunk)
  return produced
}

test('the relay runs inside the stream and stages the plan without a synthesized call', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, dev, reviewer, room } = await team(call)
  await tool('post_to_group', { group: 'R1', message: '@Dev build it @Reviewer then check it' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const produced = await streamGroup(rt, room.id, [{ role: 'user', content: post.message.content, source: post.message.source }])
  // The relay ran: the plan is staged and the group was told.
  assert.equal(Object.values(rt.state.plans ?? {}).length, 1, 'the plan was staged')
  assert.equal(Object.values(rt.state.plans)[0].status, 'draft')
  assert.ok(rt.roomEventsOf(room.id).some(line => line.type === 'plan.staged'), 'and the staging is recorded')
  // No tool-call was handed to the agent loop: the round did not go through the
  // host's scheduled-execution path that loses its inject.
  assert.ok(!produced.some(chunk => chunk.blockType === 'tool-call'), 'no synthesized call was yielded')
  assert.deepEqual(produced.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  // And nobody was called: approval is what starts approved work.
  assert.deepEqual(rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').at(-1).slots, [])
})

test('the hook reaches the relay through rt, never through a registry on ctx', async (t) => {
  // The real host answers an unknown ctx property with "without inject":
  // ctx.registeredTools is not a service it serves, and reaching for it there
  // took a whole round down (live 2026-10-25 15:2x). The relay is on rt.
  const { call, tool, emit, stop, sent, ctx, rt } = start()
  t.after(stop)
  const { chief, room } = await team(call)
  await tool('post_to_group', { group: 'R1', message: '@Dev build it @Reviewer then check it' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  // The post is queued; from here the hook must not need the registry at all.
  ctx.registeredTools = undefined
  const produced = await streamGroup(rt, room.id, [{ role: 'user', content: post.message.content, source: post.message.source }])
  assert.equal(Object.values(rt.state.plans ?? {}).length, 1, 'the relay still ran')
  assert.ok(rt.roomEventsOf(room.id).some(line => line.type === 'plan.staged'))
  assert.ok(!produced.some(chunk => chunk.blockType === 'tool-call'))
})

test('a stream with nothing queued yields nothing and relays nothing', async (t) => {
  const { call, tool, emit, stop, sent, rt } = start()
  t.after(stop)
  const { chief, dev, reviewer, room } = await team(call)
  // A relay already ran: the queue is empty, so a later stream on the same
  // history must not run a second one.
  await tool('post_to_group', { group: 'R1', message: '@Dev build it @Reviewer then check it' }, rt.chatOf(chief))
  const post = [...sent].reverse().find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await streamGroup(rt, room.id, [{ role: 'user', content: post.message.content, source: post.message.source }])
  const rounds = rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').length
  const produced = await streamGroup(rt, room.id, [{ role: 'user', content: post.message.content, source: post.message.source }])
  assert.deepEqual(produced, [{ type: 'finish', reason: { kind: 'stop' } }], 'the second stream yields only a stop')
  assert.equal(rt.roomEventsOf(room.id).filter(line => line.type === 'round.start').length, rounds, 'and runs no second round')
})
