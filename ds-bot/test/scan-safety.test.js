import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { secretish } from '../src/host/scan.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #14: a scan must not walk into where the keys live, and it must say what it
// did not cover - "I checked it" is only honest next to the gap it left.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-scan-'))
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

test('a path that holds credentials is named as such, wherever it sits', () => {
  for (const path of ['/work/.dsh/secrets.json', 'C://work//secrets.json', '/work/.env', '/work/.ssh/id_rsa', '/work/.aws/credentials', '/work/config/api_key.json']) {
    assert.equal(secretish(path), true, path)
  }
  for (const path of ['/work/report.docx', '/work/src/index.js', '/work/deliverable v3.txt']) {
    assert.equal(secretish(path), false, path)
  }
})

test('a member cannot send a credentials file even from the group folder', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-scan-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  await call('update-room', { id: room.id, workDir: dir })
  writeFileSync(join(dir, 'secrets.json'), '{"key":"x"}')
  const said = await tool('send_file', { group: 'R1', path: join(dir, 'secrets.json') }, rt.chatOf(chief))
  assert.match(said, /存放凭据/, '拒绝理由说明了为什么')
  const gap = rt.roomEventsOf(room.id).find(line => line.type === 'scan.gap')
  assert.ok(gap, 'and the gap is on record')
})

test('a scan names what it could not cover, instead of implying it saw everything', async (t) => {
  const { call, tool, stop, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-scan-dir2-'))
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-scan-out-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); rmSync(outside, { recursive: true, force: true, maxRetries: 5 }) })
  await call('update-room', { id: room.id, workDir: dir })
  writeFileSync(join(outside, 'secret.txt'), 'not for the group')
  const said = await tool('send_file', { group: 'R1', path: join(outside, 'secret.txt') }, rt.chatOf(chief))
  assert.match(said, /未覆盖/, '拒绝里带着 gap')
  assert.match(said, /不在本群的工作目录内/, '并说明了原因')
  // The scope helper says the same thing on its own: what is covered, what is not.
  const scope = rt.scanScope([join(dir, 'a.txt'), join(outside, 'b.txt'), join(dir, 'secrets.json')], [dir])
  assert.deepEqual(scope.covered, [join(dir, 'a.txt')])
  assert.equal(scope.skipped.length, 2)
  assert.match(scope.gap, /未覆盖（2 项）/)
})
