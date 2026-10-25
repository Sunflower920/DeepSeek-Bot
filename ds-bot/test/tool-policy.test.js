import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { POLICY_ALL } from '../src/host/policies.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// #8: what a Bot or a group may reach for is declared, and a policy nobody
// declared fails at the moment it is set - silently falling back to
// "everything" is how a restriction becomes decoration.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-policy-'))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek' }], listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
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
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { call, tool, stop, rt }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  return { chief, writer, room }
}

test('a policy nobody declared is refused when it is set, not later', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const said = await call('update-bot', { id: writer.id, toolPolicy: 'readonly' })
  assert.equal(said.ok, false, 'the change is refused')
  assert.match(JSON.stringify(said), /没有名为/, '并说明是哪个策略')
  assert.equal(rt.botOf(writer.id).toolPolicy, undefined, 'and nothing was written')
  const roomSaid = await call('update-room', { id: room.id, toolPolicy: 'nope' })
  assert.equal(roomSaid.ok, false, 'the room refuses it too')
  // Declaring it first is what makes it usable.
  await call('set-tool-policy', { id: 'readonly', tools: ['read_group_chat'] })
  assert.equal(rt.isDeclaredPolicy('readonly'), true)
  assert.equal(rt.isDeclaredPolicy('nope'), false)
})

test('a declared policy gates the tool, and names itself in the refusal', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  const declared = await call('set-tool-policy', { id: 'quiet', tools: ['read_group_chat'] })
  assert.equal(declared.ok, true, 'the policy is declared')
  const held = await call('update-bot', { id: writer.id, toolPolicy: 'quiet' })
  assert.equal(held.ok, true, 'the declared policy is accepted')
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-policy-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  await call('update-room', { id: room.id, workDir: dir })
  const store = fakeAttachments()
  rt.ctx.get = name => (name === 'attachments' ? store : undefined)
  writeFileSync(join(dir, 'report.txt'), 'the report')
  const said = await tool('send_file', { group: 'R1', path: join(dir, 'report.txt') }, rt.chatOf(writer.id))
  assert.match(said, /不在当前「quiet」策略/, '拒绝理由指明了策略')
  // A Bot under no policy, and "all", are unchanged.
  assert.equal(rt.allowsTool('send_file', { botId: chief }), true)
  assert.equal(rt.allowsTool('send_file', { botId: writer.id }), false)
  await call('update-bot', { id: writer.id, toolPolicy: POLICY_ALL })
  assert.equal(rt.allowsTool('send_file', { botId: writer.id }), true, 'and "all" restores everything')
})
