import { randomUUID } from 'node:crypto'

//
// A dispatch that names two or more workers used to start them at once. It now
// stages a plan instead - who does what, in what order, with what deliverable -
// and the work begins only when the plan is approved. The plan lives in
// state.plans, so it survives a restart and the panel can show it.
//
// Before approval a plan may be revised as often as the admin likes, and every
// rewrite is kept in `revisions` - that ledger is how a reader tells "it was
// always so" from "it was changed after the work began". After approval the
// plan is frozen: a further change is refused, because work already running
// against the old shape cannot be un-run.
export const PLAN_STATUS = ['draft', 'approved', 'running', 'done', 'rejected']
export const REVISIONS_KEPT = 20

// What a reader or the admin says to let staged work begin, or to send it back.
export const APPROVE_MARK = /(同意|批准|就这么干|就这样干|开始干|照做|照这个做|执行吧|开工|干吧可以|approve(d)?|run it|go ahead|lgtm|ship it)/i
export const REJECT_MARK = /(不行|不同意|不批准|驳回|改一下|改改|重新出|推翻|换个方案|reject(ed)?|revise|no,? (let'?s )?(revise|change))/i

export const pendingPlanOf = (state, roomId) => Object.values(state.plans ?? {})
  .find(plan => plan.roomId === roomId && (plan.status === 'draft' || plan.status === 'approved'))
export const planOf = (state, id) => state.plans?.[id]

export function install(rt) {
  const { ctx } = rt

  const save = () => { void rt.save().catch(() => {}) }

  // The shape of one step: who, what for, and what they hand back. `order` is
  // fixed at staging time so a revision cannot silently reorder running work.
  const stepsOf = (members, text) => members.map((bot, index) => ({
    botId: bot.id, name: bot.name, order: index + 1,
    task: taskFor(text, bot.name, members.map(member => member.name)), deliverable: '',
  }))

  // The words aimed at one member: from their own @name to the next @name (or
  // the end), so a step reads as the instruction given to that member and not
  // as a copy of the whole dispatch. A dispatch is written "@A 改这三处 @B 改
  // 完审查", and the segment between the mentions is what each one was asked.
  const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Longest name first: "开发" must not match inside "开发工程师".
  const mentionPattern = names => new RegExp(`@(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'g')
  const taskFor = (text, name, names) => {
    const all = names ?? [name]
    const raw = String(text ?? '')
    const spans = [...raw.matchAll(mentionPattern(all))].map(hit => ({
      at: hit.index,
      end: hit.index + hit[0].length,
      name: all.find(candidate => raw.startsWith(`@${candidate}`, hit.index)) ?? name,
    }))
    const own = spans.find(span => span.name === name)
    const from = own === undefined ? 0 : own.end
    const until = spans.find(span => span.at >= from)?.at ?? raw.length
    const segment = raw.slice(from, until).trim()
    // An empty segment ("@A @B 一起干" leaves A nothing) falls back to the
    // whole message minus the mentions: a shared instruction is better than a
    // step that reads as if nobody had said anything.
    const shared = raw.replace(mentionPattern(all), ' ').replace(/\s+/g, ' ').trim()
    return (segment.length > 0 ? segment : shared).slice(0, 200)
  }

  // Stage (or restate) the work a dispatch describes. A second dispatch while a
  // draft is pending rewrites it and the old shape goes into the ledger.
  function stagePlan(room, opener, members) {
    rt.state.plans ??= {}
    const pending = pendingPlanOf(rt.state, room.id)
    const steps = stepsOf(members, opener.text)
    if (pending !== undefined) {
      pending.revisions ??= []
      pending.revisions.push({ at: Date.now(), by: opener.botId ?? null, steps: pending.steps, text: pending.text })
      trimRevisions(pending)
      pending.steps = steps
      pending.text = opener.text
      pending.status = 'draft'
      save()
      return { plan: pending, revised: true }
    }
    const id = randomUUID()
    const plan = {
      id, roomId: room.id, by: opener.botId ?? null, text: String(opener.text ?? '').slice(0, 400),
      steps, deliverables: [], status: 'draft', revisions: [],
      createdAt: Date.now(), ...(opener.kickoff ? { kickoff: true } : {}),
    }
    rt.state.plans[id] = plan
    save()
    return { plan, revised: false }
  }

  // Approval: the plan starts to run. Rejection: it is put away, and the
  // ledger keeps what was proposed.
  function approvePlan(plan, by, { reason = '' } = {}) {
    plan.status = 'approved'
    plan.approvedAt = Date.now()
    plan.approvedBy = by ?? null
    if (reason) plan.approvedReason = String(reason).slice(0, 200)
    save()
    return plan
  }
  function rejectPlan(plan, by, { reason = '' } = {}) {
    plan.status = 'rejected'
    plan.rejectedAt = Date.now()
    plan.rejectedBy = by ?? null
    if (reason) plan.rejectedReason = String(reason).slice(0, 200)
    save()
    return plan
  }
  const startPlan = plan => {
    if (plan.status === 'approved') { plan.status = 'running'; plan.startedAt = Date.now(); save() }
    return plan
  }
  const finishPlan = plan => {
    if (plan.status === 'running') { plan.status = 'done'; plan.finishedAt = Date.now(); save() }
    return plan
  }

  const trimRevisions = plan => {
    if ((plan.revisions?.length ?? 0) <= REVISIONS_KEPT) return
    plan.revisions = plan.revisions.slice(-REVISIONS_KEPT)
  }

  // What the panel and the state endpoint show: no step text longer than it
  // needs to be, and the ledger's length rather than its whole body.
  const plansView = () => Object.values(rt.state.plans ?? {}).map(({ text, ...plan }) => ({
    ...plan, revisions: plan.revisions?.length ?? 0,
  }))

  Object.assign(rt, { stagePlan, approvePlan, rejectPlan, startPlan, finishPlan, pendingPlanOf, planOf, plansView, APPROVE_MARK, REJECT_MARK })
}
