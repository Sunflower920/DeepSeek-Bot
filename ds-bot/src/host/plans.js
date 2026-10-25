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
    task: taskFor(text, bot.name), deliverable: '',
  }))

  // The words aimed at one member: the sentence that names them, if any, so a
  // step reads as an instruction and not as a copy of the whole message.
  const taskFor = (text, name) => {
    const clean = String(text ?? '').replace(new RegExp(`@${name}`, 'g'), ' ').trim()
    const parts = clean.split(/[。；;\n]/).map(part => part.trim()).filter(Boolean)
    return (parts.find(part => part.length > 2) ?? clean).slice(0, 200)
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
