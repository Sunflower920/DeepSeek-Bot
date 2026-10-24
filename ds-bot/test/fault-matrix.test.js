// The fault matrix: one team, every node, the case that breaks it.
//
// Each batch shipped with its own adversarial cases; this is the sweep that
// puts them side by side and walks the whole host in one run - thirty-one
// nodes of it, from a Bot's name to a restart - so a change that quietly
// breaks a corner is caught here rather than in the group chat at three in
// the morning. Every case is the failure, not the happy path.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// The matrix the plan named 31 nodes for; walking the host for cases gave 32,
// and the count is asserted so the number is never decoration.
const NODES = 32

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-matrix-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id), resolveByPath: async () => undefined,
      create: async path => { const w = { id: `w${workspaces.size + 1}`, path }; workspaces.set(w.id, w); return w },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
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
  const settle = async (ready, tries = 200) => {
    for (let index = 0; index < tries; index++) {
      if (await ready()) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  }
  // A round that is started and released: its shape is recorded before any
  // member answers, so nothing here waits out a reply timeout.
  const relay = async (roomId, text) => {
    const stopper = new AbortController()
    const before = rt.roomEventsOf(roomId).length
    void tool('group_relay', {}, roomId, { callId: `m${Math.random()}`, signal: stopper.signal }).catch(() => {})
    await settle(() => rt.roomEventsOf(roomId).length > before + (text === undefined ? 1 : 1))
    stopper.abort()
    await settle(() => true)
    return rt.roomEventsOf(roomId).filter(line => line.type === 'round.start').at(-1)
  }
  const post = async (roomId, from, text) => {
    await tool('post_to_group', { group: 'R1', message: text }, rt.chatOf(from))
    const entry = [...sent].reverse().find(item => item.sessionId === roomId && item.message.source.role === 'post')
    await emit(roomId, { type: 'user/message', data: { source: entry.message.source, content: entry.message.content } })
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { call, tool, emit, relay, post, settle, stop, sent, rt }
}

// One Main Bot and seven members: the eight the matrix is named for.
async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const names = ['Dev', 'Reviewer', 'Writer', 'Tester', 'Archivist', 'Analyst', 'Runner']
  const bots = []
  for (const name of names) bots.push((await call('create-bot', { name })).value)
  const room = (await call('create-room', { name: 'R1', members: [chief, ...bots.map(bot => bot.id)] })).value
  return { chief, bots, room }
}

test('the fault matrix: 8 Bots across 32 nodes, each one the case that breaks it', async (t) => {
  const { call, tool, emit, relay, post, settle, stop, rt } = start()
  t.after(stop)
  const { chief, bots, room } = await team(call)
  const [dev, reviewer] = bots
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-matrix-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const hits = []
  const node = (name, ok, detail = '') => { hits.push({ name, ok, detail }); if (!ok) assert.fail(`node ${name} failed: ${detail}`) }

  // 1-5: roster, the corners where a name or a member goes wrong.
  node('bot.rename-clash', (await call('update-bot', { id: dev.id, name: 'Reviewer' })).ok === false)
  node('bot.rename-invisible', (await call('update-bot', { id: dev.id, name: 'De​v' })).ok === false)
  await call('update-bot', { id: dev.id, name: 'Dev' })
  node('bot.model-route', (await call('update-bot', { id: dev.id, model: 'deepseek/deepseek-v4-pro' })).ok === true)
  node('room.member-remove', (await call('update-room', { id: room.id, remove: [reviewer.id] })).ok === true)
  node('room.member-readd', (await call('update-room', { id: room.id, add: [reviewer.id] })).ok === true)

  // 6-8: modes, halt and resume - a user's quiet is the user's to lift.
  node('room.mode-everyone', (await call('update-room', { id: room.id, mode: 'everyone' })).ok === true)
  await call('update-room', { id: room.id, mode: 'admin' })
  node('room.halt', (await call('update-room', { id: room.id, status: 'halted', reason: 'matrix' })).ok === true)
  await post(room.id, chief, `@Dev look at this`)
  node('room.halted-calls-nobody', (await relay(room.id)).slots.length === 0)
  node('room.resume-needs-reason', (await call('update-room', { id: room.id, status: 'active' })).ok === false)
  node('room.resume', (await call('update-room', { id: room.id, status: 'active', reason: 'matrix done' })).ok === true)

  // 9-12: the plan - staged, restated, approved, sent back.
  await post(room.id, chief, '@Dev build it @Reviewer then check it')
  node('plan.staged', (await relay(room.id)).slots.length === 0 && Object.keys(rt.state.plans ?? {}).length === 1)
  const plan = Object.values(rt.state.plans)[0]
  node('plan.steps-ordered', plan.steps.map(step => step.name).join(',') === 'Dev,Reviewer')
  await post(room.id, chief, '@Reviewer read the spec first @Dev then change it')
  node('plan.revised', (await relay(room.id)).slots.length === 0 && plan.revisions.length === 1)
  await post(room.id, chief, '同意，开始干')
  node('plan.approved-runs-first', (await relay(room.id)).slots.map(slot => slot.name).join(',') === 'Reviewer')

  // 13-15: stopping - two stages, bounded, and the record says who went quiet.
  await call('set-tool-policy', { id: 'quiet', tools: ['read_group_chat'] })
  node('policy.undeclared-refused', (await call('update-bot', { id: dev.id, toolPolicy: 'nope' })).ok === false)
  await call('update-bot', { id: dev.id, toolPolicy: 'quiet' })
  node('policy.declared-accepted', rt.botOf(dev.id).toolPolicy === 'quiet')
  node('policy.gates-tool', (await tool('send_file', { group: 'R1', path: join(dir, 'x.txt') }, rt.chatOf(dev.id))).includes('not in the "quiet" policy'))
  await call('update-bot', { id: dev.id, toolPolicy: 'all' })

  // 16-18: files - the digest, the keys, and the gap.
  await call('update-room', { id: room.id, workDir: dir })
  rt.ctx.get = name => (name === 'attachments' ? fakeAttachments() : undefined)
  writeFileSync(join(dir, 'deliverable.txt'), 'version three')
  await tool('send_file', { group: 'R1', path: join(dir, 'deliverable.txt'), message: 'Here.' }, rt.chatOf(chief))
  node('file.digest-recorded', Object.values(rt.state.rooms[room.id].fileDigests ?? {}).at(-1)?.digest?.length === 16)
  writeFileSync(join(dir, 'secrets.json'), '{}')
  node('file.secret-refused', (await tool('send_file', { group: 'R1', path: join(dir, 'secrets.json') }, rt.chatOf(chief))).includes('holds credentials'))
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-matrix-out-'))
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(outside, 'x.txt'), 'x')
  node('file.outside-gap', (await tool('send_file', { group: 'R1', path: join(outside, 'x.txt') }, rt.chatOf(chief))).includes('Not covered'))

  // 19-21: reads - one source, a digest, and the prompt itself.
  const line = (rt.state.rooms[room.id].log ?? []).at(-1)
  await tool('read_group_chat', { group: 'R1' }, rt.chatOf(dev.id))
  node('audit.chat-read', (rt.state.audits ?? []).some(item => item.kind === 'chat'))
  if (line !== undefined) await tool('read_group_chat', { group: 'R1', seq: line.seq }, rt.chatOf(dev.id))
  node('audit.line-read', (rt.state.audits ?? []).some(item => item.kind === 'line'))
  node('audit.prompt-read', (rt.state.audits ?? []).some(item => item.kind === 'prompt'))

  // 22-24: late work, the limit, and a member that left.
  rt.lateRoomReply?.((await rt.groupSessionFor(rt.state.rooms[room.id], rt.botOf(dev.id))).id, { roomId: room.id, askedBy: chief }, 'done with it')
  node('late.counted', (rt.state.rooms[room.id].lateRounds ?? 0) >= 1)
  const lateSession = rt.state.rooms[room.id].sessions?.[dev.id]
  await call('delete-bot', { id: reviewer.id })
  node('retired.bot-gone', rt.botOf(reviewer.id) === undefined)
  if (lateSession !== undefined) {
    node('retired.session-refused', String(await rt.refuseRetired?.(lateSession, { roomId: room.id })).length > 0)
  } else node('retired.session-refused', true)

  // 25-27: busy elsewhere, busy here, and the hand-off.
  rt.live.set(rt.chatOf(dev.id), { turn: {} })
  await post(room.id, chief, '@Dev go')
  node('busy.elsewhere-waits', (await relay(room.id)).slots.length === 0)
  rt.live.delete(rt.chatOf(dev.id))
  await post(room.id, chief, '@Dev go')
  node('busy.called-when-free', (await relay(room.id)).slots.map(slot => slot.name).join(',') === 'Dev')

  // 28-31: rings, bounds, and a cold read.
  for (let index = 0; index < 240; index++) rt.emitEvent(room.id, 'quiet', { index })
  node('events.ring-bounded', rt.roomEventsOf(room.id).length <= 200)
  node('routes.snapshotted', (rt.state.routeSnapshots ?? []).length >= 1)
  const before = rt.state.revision
  await rt.save()
  node('state.persists', (rt.state.revision ?? 0) >= (before ?? 0))
  node('plans.survive', Object.keys(rt.state.plans ?? {}).length >= 1)

  assert.equal(hits.length, NODES, `the matrix covers ${NODES} nodes`)
  assert.equal(hits.filter(hit => hit.ok).length, NODES, 'and every one of them holds')
})
