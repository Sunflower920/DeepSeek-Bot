import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #9: where a Bot was routed is kept as a snapshot - what it asked for, what it
// got, and when - so a turn can be reproduced and "it ran on the wrong model"
// is a question the record answers.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-route-'))
  const ctx = fakeContext()
  const picked = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async id => ({ agent: { session: { id }, followup: () => {} } }),
      selectModel: async (agent, route) => { picked.push(route) },
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
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { call, stop, picked, rt }
}

test('a Bot\'s route is kept as a snapshot, and a change adds another', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  const bot = rt.botOf(chief)
  const applied = await rt.applyModel(bot, { force: true })
  assert.equal(applied, 'deepseek/deepseek-v4-flash', 'the bot is routed')
  const first = (rt.state.routeSnapshots ?? []).at(-1)
  assert.ok(first, 'the route is recorded')
  assert.equal(first.botId, chief)
  assert.equal(first.applied, bot.appliedModel)
  assert.equal(first.asked, bot.model ?? null)
  assert.ok(first.at > 0, 'with when')
  // Moving the Bot records the new route and keeps the old one: a run can be
  // read back as it was, not only as it is now.
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-pro' })
  await rt.applyModel(rt.botOf(chief), { force: true })
  const snapshots = rt.state.routeSnapshots ?? []
  assert.ok(snapshots.length >= 2, 'each route is kept')
  assert.notEqual(snapshots.at(-1).applied, first.applied, 'and the new one differs')
})

test('the panel sees the recent routes, newest last', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await rt.applyModel(rt.botOf(chief), { force: true })
  const view = rt.routesView()
  assert.ok(view.length >= 1)
  assert.equal(view.at(-1).botId, chief)
  assert.ok('applied' in view.at(-1), 'with what it ran on')
})
