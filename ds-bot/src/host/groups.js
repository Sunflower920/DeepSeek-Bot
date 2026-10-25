// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. A group chat is one shared, ordered conversation, so members
// speak one at a time: a turn starts only after the previous speaker has posted or
// passed, and it shows everything that arrived since that member last looked, plus
// the speaking order and the member's place in it. Nobody answers a room that has
// moved on, and nobody has to count lines to know who went before. A plain message
// goes to every member in roster order, admin first, or to the admin alone in admin
// mode; "@Name" picks members. A reply that @mentions a member calls that member
// next, bounded per member and per round; the admin's calls reach further.
//
// Work does not hold a round up: a member that is still busy with tools a little after
// it started, or that is called while still at earlier work, lets the round go on. Its
// turn keeps running in its group Session, and what it ends with is posted to the group,
// where the member that asked for it answers.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GROUP_LINE_READ, ROOM_LATE_ROUNDS, ROOM_REPLY_TIMEOUT_MS, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS, SOURCE_KIND, TEAM_TOOLS, TEXT_KEPT } from './constants.js'
import { escapeRegExp, headOf, splitRef, textOf } from './text.js'
import { mentionSpans, speakerOf } from '../shared/mentions.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_TURNS_EACH = 2
const ROOM_ADMIN_TURNS_EACH = 4

// Logs written before rooms were versioned get sequence numbers in place.
const ensureRoomLog = (room) => {
  if (typeof room.seq !== 'number') {
    room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
    room.seq = room.log.length
  }
  room.seen ??= {}
}

// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

// `text` is what to show of a message line, by default what the log keeps of it.
const lineText = (line, text = line.text) => {
  if (line.kind === 'lookup') return `[${speakerOf(line)} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${speakerOf(line)}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${speakerOf(line)}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${speakerOf(line)}'s work here]`
  if (line.kind === 'done') return `[${speakerOf(line)} finished the work it was asked for]`
  if (line.kind === 'notice') return `[${text}]`
  return `${speakerOf(line)}: ${text}`
}
const transcript = (lines, textOfLine = line => line.text) => lines.map(line => lineText(line, textOfLine(line))).join('\n')

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// Who "@" calls, in order, by the same rule the bubbles draw. `references` are the
// round's referenced conversations: each one's "@label" is a reference, not a call.
// Pass every member, the speaker too, so "@新 Bot 2" said by 新 Bot 2 is never read as
// a call to 新 Bot; the caller drops the speaker.
export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_CALLS = 'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. Every "@Name" in your own reply is called. A dispatch from the admin calls only the first member it names — the others wait for the hand-off — so give work to one member at a time and let the one that finishes call the next. To only mention a member, write its name without "@".'

const slotLabel = (slot) => {
  if (slot.status === 'speaking') return `${slot.name} (you, now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

// The opening turn of a group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

// DSH cannot open the Session at all: it is gone, or its stored log is corrupt. DSH
// reports a corrupt log only in the message of a generic failure.
const lostSession = error => error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
// The digest rides with the file wherever the group reads it: what was sent is
// what a later claim about it is checked against, so "the draft changed under
// it" is a fact rather than an argument.
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes)${file.digest ? `, sha256 ${file.digest}` : ''} attached]`

export function install(rt) {
  const { ctx } = rt

  // A long line keeps its start in state.json, which is written whole on every save,
  // and what a member reads of it (GROUP_LINE_READ) in a file of its own: written once,
  // before the state that names it, and removed with the line. All of it stays in the
  // group's Session, where the group chat shows it.
  const linesDir = join(rt.home, 'group-lines')
  const lineFile = (roomId, seq) => join(linesDir, roomId, `${seq}.txt`)
  const wholeLines = new Map()
  const lineKey = (roomId, seq) => `${roomId}/${seq}`
  const writes = () => rt.readOnly?.() === undefined

  function keepGroupLine(roomId, line, text) {
    const kept = headOf(text, TEXT_KEPT)
    if (kept.length === text.length) return line
    const read = headOf(text, GROUP_LINE_READ)
    wholeLines.set(lineKey(roomId, line.seq), read)
    if (writes()) {
      try {
        mkdirSync(join(linesDir, roomId), { recursive: true })
        writeFileSync(lineFile(roomId, line.seq), read, 'utf8')
      } catch (error) {
        rt.warn('ds-bot: group line %s/%s not kept whole: %s', roomId, line.seq, error)
      }
    }
    return { ...line, text: kept, length: text.length }
  }

  function dropGroupLine(roomId, line) {
    if (line.length === undefined) return
    wholeLines.delete(lineKey(roomId, line.seq))
    if (writes()) void rm(lineFile(roomId, line.seq), { force: true }).catch(() => {})
  }

  function dropGroupLines(roomId) {
    for (const key of wholeLines.keys()) if (key.startsWith(`${roomId}/`)) wholeLines.delete(key)
    if (writes()) void rm(join(linesDir, roomId), { recursive: true, force: true }).catch(() => {})
  }

  // After a restart the whole lines are read back before a member reads them.
  const loadGroupLines = room => Promise.all(room.log
    .filter(line => line.length !== undefined && !wholeLines.has(lineKey(room.id, line.seq)))
    .map(line => readFile(lineFile(room.id, line.seq), 'utf8').then(text => { wholeLines.set(lineKey(room.id, line.seq), text) }, () => {})))

  // What a member reads of a line: all of it, up to GROUP_LINE_READ.
  const memberText = room => (line) => {
    const read = line.length === undefined ? line.text : wholeLines.get(lineKey(room.id, line.seq))
    if (read === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const length = line.length ?? read.length
    const shown = headOf(read, GROUP_LINE_READ)
    return length > shown.length ? `${shown}… (cut; ${length} characters in all)` : shown
  }

  const appendRoom = (room, line) => {
    room.seq += 1
    // parts.js reaches this at a switch, which a group with no logged line yet can do;
    // it must not fail there, or the member would not move on at all.
    const log = [...(room.log ?? []), keepGroupLine(room.id, { ...line, seq: room.seq }, line.text ?? '')]
    for (const gone of log.slice(0, -ROOM_LOG_MAX)) dropGroupLine(room.id, gone)
    room.log = log.slice(-ROOM_LOG_MAX)
  }
  // On `rt` so parts.js can tell the group a member moved to a fresh part: the member
  // then answers nobody for a while, which without a note reads as it being gone.
  Object.assign(rt, { keepGroupLine, dropGroupLines, appendRoom, groupSessionFor })

  // A member's group Session, created on its first turn there. A new one starts with
  // a fresh look at the log and a brief of the member's own chat; the brief is the
  // first message, so it stays fixed and the prefix stays cacheable.
  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }) })
    // While the Session was made the member may have left or been deleted, the group been
    // deleted, or another turn made the member's Session first: the new one is not kept.
    // Undefined means the member is gone from the group.
    const gone = rt.roomOf(room.id) !== room || !room.members.includes(member.id) || rt.botOf(member.id) === undefined
    if (gone || room.sessions?.[member.id] !== undefined) {
      void ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused group Session of %s in %s not archived: %s', member.name, room.name, error))
      return gone ? undefined : groupSessionFor(room, member)
    }
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    room.seen ??= {}
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      await rt.selectSessionModel(id, splitRef(ref))
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.applyPermission(member, id, room)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  // A post that asks for nothing but an acknowledgement. The same closing test
  // the gateway runs on a short user message, run here on the post that opened
  // the round: a group round prompt is long, so the gateway cannot see the
  // directive inside it - the round states its intent instead (the gateway's
  // ROUND_ACK_MARKER), and a member's "收到" ships as the answer it is instead
  // of rotating into an announce-only budget (live 2026-10-25 00:29).
  // The plan as the group reads it: who does what, in what order.
  const planText = plan => plan.steps.map(step => `${step.order}. ${step.name} — ${step.task}`).join('; ')

  // A word from the user or the admin about the plan waiting in this room.
  // Approval runs the plan's steps in their order; rejection puts it away.
  // Without this a plan would only ever be staged and never start.
  async function applyPlanWord(room, opener) {
    const pending = rt.pendingPlanOf(rt.state, room.id)
    if (pending === undefined || pending.status !== 'draft') return undefined
    const text = String(opener.text ?? '')
    const by = opener.botId ?? null
    const allowed = by === null || rt.isAdminOf(room, by) || rt.isMain(by)
    if (!allowed) return undefined
    if (rt.REJECT_MARK.test(text)) {
      rt.rejectPlan(pending, by, { reason: text.slice(0, 100) })
      appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `方案已驳回：${pending.rejectedReason ?? '管理员要求修改'}。未开始任何工作。` })
      rt.emitEvent(room.id, 'plan.rejected', { id: pending.id, by: by ?? 'user' })
      return { rejected: true }
    }
    if (rt.APPROVE_MARK.test(text)) {
      rt.approvePlan(pending, by, { reason: text.slice(0, 100) })
      rt.startPlan(pending)
      appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `已批准，工作开始：${planText(pending)}` })
      rt.emitEvent(room.id, 'plan.approved', { id: pending.id, by: by ?? 'user', steps: pending.steps.map(step => step.name) })
      return { approved: true, steps: pending.steps, plan: pending }
    }
    return undefined
  }

  const CLOSING_MARK = /(收工|结束吧|不用了|不必了|先这样|就这样|可以了|行了|够了|算了|辛苦了|谢谢|感谢|不存档|不用存档|先存档|存档吧|随时叫我|有活.*叫我|下班|明天再|下次再|暂停|停下|停吧|好吧|好的|好|可以|嗯|收到)/
  const ACTION_REQUEST = /(接下来|马上|立刻|立即|开始|动起来|改一下|做一下|试一下|跑一下|处理|改|做|执行|跑|调用|查|找|分析|写|生成|创建|新建|删除|修|排查|检查|测试|部署|安装|配置|更新|优化|重构|翻译|总结|列出|统计|对比|帮我|请|麻烦)/
  const ACTION_NEGATED = /(不用|不必|不需要|不要|不准|不许|无须|别|先不|甭|禁止)/
  const asksAcknowledgementOnly = text => {
    const value = String(text ?? '').trim()
    if (value === '' || value.length > 60) return false
    if (!CLOSING_MARK.test(value)) return false
    if (ACTION_NEGATED.test(value)) return true
    return !ACTION_REQUEST.test(value)
  }
  // The note the member reads, and the marker the gateway looks for in the same
  // breath: the display is Chinese, the English phrase is the protocol constant
  // both sides agreed on (docs/执行规范.md: display Chinese, constants bilingual).
  const ACK_ROUND_NOTE = '本轮只求一个“收到”，不要求执行任何工作（this round asks for an acknowledgement only; no work is requested）。直接回复“收到”即可。'

  // `files` are the files of the lines shown, which go to the member with the prompt.
  function roomPrompt(room, member, round) {
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const index = round.slots.findIndex(slot => slot.status === 'speaking')
    const before = index
    const after = round.slots.length - index - 1
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. Members speak one at a time; each message is posted before the next speaker starts. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) return { text: [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n'), files: [] }
    const working = workingIn(room).filter(item => item.bot.id !== member.id)
      .map(item => ({ ...item, unread: unreadCount(room, item.bot.id) }))
    const text = [
      members,
      notice,
      leads ? adminNote(room) : '',
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier, memberText(room))}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current, memberText(room))}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min${item.unread > 0 ? `, with ${item.unread} group message(s) it has not read yet` : ''})`).join(', ')}.` : '',
      round.ackOnly ? ACK_ROUND_NOTE : '',
      `Speaking order for this round: ${round.slots.map(slotLabel).join(' → ')}.`,
      `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
    // The biggest read of all: what this member is shown of the group each turn.
    // It goes through the same source, with the span of lines it covers, so the
    // prompt a member acted on is on record as much as a read_group_chat call.
    const shown = [...earlier, ...current]
    rt.auditRead({
      roomId: room.id, botId: member.id, kind: 'prompt', text,
      ...(shown.length > 0 ? { from: shown[0].seq, to: shown.at(-1).seq } : {}),
    })
    return { text, files: shown.flatMap(line => line.files ?? []) }
  }

  // Members whose turn in this group is running, and since when.
  const workingIn = room => room.members.flatMap((id) => {
    const entry = rt.live.get(room.sessions?.[id])
    const bot = rt.botOf(id)
    return entry?.turn !== undefined && bot !== undefined ? [{ bot, since: entry.since ?? Date.now() }] : []
  })
  // How many group lines a member has not been shown yet, counted the same way a
  // round counts the lines it carries over (unseenLines), so the number a speaker
  // reads is the number the member would get. A turn the reply timeout cut short
  // may leave them unread, and the member is never called again: the next speaker
  // is told, so it knows the hand-off it waits on sits behind unread lines.
  const unreadCount = (room, botId) => unseenLines(room, botId).length
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // A member's message in the round: in the log, for the members after it, and in the
  // round's replies, for the user.
  const postInRound = (room, round, member, text) => {
    appendRoom(room, { who: member.name, botId: member.id, text })
    round.replies.push({ botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
    void rt.save().catch(() => {})
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
  // it waits for the user's approval, `{ working }` when it goes on working without the
  // round, or null when the round was stopped. The wait restarts on each event of the
  // member's Session, so a member at work is never cut off. `by` is the member that
  // called it, which answers what the turn posts after the round moved on. What the
  // member writes before its last step is posted at once and collected in `said`.
  async function roomTurn(room, member, sessionId, { text, files }, note, signal, round, by, said = []) {
    if (signal.aborted) return null
    const exchangeId = randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    room.seen[member.id] = room.seq
    // Checked before the delivery, which may start the turn at once.
    const busy = rt.live.get(sessionId)?.turn !== undefined
    const done = new Promise((resolve) => {
      let timer
      let grace
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        rt.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS) }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        postInRound(room, round, member, step)
      }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, say, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text, files, ...(by ? { askedBy: by } : {}) })
      // Still held by an earlier request: this turn cannot start until the user answers.
      if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      // Still at earlier work: the call waits in its inbox and is answered after that.
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      // A delivery that failed is not a pass: the round shows it. Nothing here can
      // repair a lost Session, so the member's next turn in the group starts a new one.
      const lost = lostSession(error)
      if (lost && room.sessions?.[member.id] === sessionId) {
        rt.retireGroupSession(room, member.id)
        void rt.save().catch(() => {})
      }
      rt.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    // A turn that ended leaves nothing for a stop to cancel.
    if (typeof reply === 'string' || reply?.failure !== undefined) started.splice(started.indexOf(turn), 1)
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  // A member that reaches its context limit mid-turn goes on in a fresh Session, so a
  // waiter is also found by the member and group that Session now speaks for.
  const waitersOf = (sessionId) => {
    const owner = rt.groupOwners.get(sessionId)
    return [...rt.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId
      || (owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  }
  rt.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  rt.failRoomTurn = (sessionId, failure) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.fail(failure)
    return waiters.length > 0
  }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // The team's own tools are quick; any other tool is the start of work.
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
  rt.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    for (const waiter of waitersOf(sessionId)) waiter.work()
  }

  // A called member moves up if it is still waiting, or gets one more turn if it
  // already spoke; either way it goes right after slot `index`. `cap` is the caller's
  // per-member turn bound for the round; `by` is the calling member, if a member called.
  function callMembers(round, turns, index, callees, note, cap, by) {
    let next = index + 1
    for (const peer of callees) {
      if ((turns.get(peer.id) ?? 0) >= cap) {
        // The bound drops the call in silence: the caller's "@Name" sits in the log
        // and reads as a hand-off, while the member never hears of it. Keep the drop
        // in the round, so the group is told once (noteDropped).
        round.dropped ??= []
        round.dropped.push({ name: peer.name, cap })
        continue
      }
      const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
      const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
      called.note = note
      if (by === undefined) delete called.by
      else called.by = by
      round.slots.splice(next, 0, called)
      next += 1
    }
  }

  // Calls the per-member turn bound dropped, told to the group once per batch of
  // calls: the drop is found while the caller's own reply is handled, so the group
  // hears of it with that reply and not at the end of the round — a round may see
  // several batches, one for the user's message and one for each member's reply.
  // The log already shows the "@Name" that went out, so without this the hand-off
  // looks done while nobody was called: the round moved on and the caller waits for
  // an answer that never starts. The admin can carry the message on, or the round
  // ends and the next one calls again.
  const noteDropped = (room, round) => {
    const dropped = round.dropped ?? []
    if (dropped.length === 0) return
    round.dropped = []
    const names = [...new Set(dropped.map(item => item.name))]
    const admin = rt.botOf(room.admin)
    const via = admin !== undefined ? ` @${admin.name} can pass it on, or` : ''
    appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `@${names.join(' and @')} was not called: this round's per-member turn limit (${dropped[0].cap}) is reached, so the message is in the log but reaches nobody.${via} end this turn and call again in the next round.` })
    rt.emitEvent(room.id, 'standby.dropped', { names })
    void rt.save().catch(() => {})
  }

  // The user's messages waiting in the group Session's inbox while a round runs, from
  // the composer whether it queued or steered them. Images and chat references are
  // only read when the Session takes the message itself, so a message with either
  // stays for the next round, and so does everything after it in that list.
  const waitingLines = agent => ['nextStep', 'nextTurn'].flatMap((list) => {
    const lines = []
    for (const message of agent?.inbox?.[list] ?? []) {
      if (message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) break
      lines.push({ id: message.id, text })
    }
    return lines
  })

  // Messages the user sent while this round is running post into the log before the
  // next speaker, so everyone still to speak sees them. The members the message's own
  // round would open with answer it next, inside this round. Each message leaves the
  // Session's inbox, so it does not open another round when this one ends. Returns
  // the number of turns added, which the round's limit allows for.
  function drainRoomInbox(room, round, turns, index, agent) {
    // The greeting's prompt tells the admin the user has not written yet.
    if (round.kickoff) return 0
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return 0
    const before = round.slots.length
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      appendRoom(room, { who: 'User', text: line.text })
      round.replies.push({ kind: 'user', text: line.text, time: Date.now() })
      // A message that asks for work overrides the acknowledgement-only intent the
      // round opened with, so the marker does not outlive the instruction.
      if (!asksAcknowledgementOnly(line.text)) delete round.ackOnly
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      callMembers(round, turns, index - 1, openingSpeakers(room, { text: line.text }).speakers, note, ROOM_ADMIN_TURNS_EACH)
      noteDropped(room, round)
    }
    // The user spoke in this room, so late results may call members again.
    resumeForUser(room)
    return round.slots.length - before
  }

  async function runRound(room, round, signal, agent) {
    let limit = round.slots.length + ROOM_EXTRA_TURNS + (room.admin ? ROOM_ADMIN_EXTRA_TURNS : 0)
    const turns = new Map()
    // The inbox check keeps a message sent during the last speaker's turn inside
    // this round: it drains at the loop's head even once the slots ran out.
    for (let index = 0; (index < round.slots.length || waitingLines(agent).length > 0) && round.turns < limit; index += 1) {
      if (signal.aborted) break
      limit += drainRoomInbox(room, round, turns, index, agent)
      if (index >= round.slots.length) break
      const slot = round.slots[index]
      const member = rt.botOf(slot.id)
      // Settings may change mid-round, for example when the admin removes someone.
      if (member === undefined || !room.members.includes(slot.id)) {
        slot.status = 'left'
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns += 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      let session
      try {
        session = await groupSessionFor(room, member)
      } catch (error) {
        rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
        round.speaking = null
        slot.status = 'failed'
        round.failed.push(member.name)
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
        continue
      }
      if (session === undefined) {
        round.speaking = null
        slot.status = 'left'
        continue
      }
      await loadGroupLines(room)
      const prompt = roomPrompt(room, member, round)
      round.shown?.push(member.id)
      const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
      const said = []
      const reply = await roomTurn(room, member, session.id, { text, files: prompt.files }, slot.note ?? 'your turn', signal, round, slot.by, said)
      round.speaking = null
      const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
      if (reply?.failure !== undefined) {
        // Not a pass: the user sees why the member is silent, and the round goes on.
        slot.status = 'failed'
        round.failed.push(member.name)
        const { code, status, message } = reply.failure
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      } else if (reply?.approval) {
        // The member's turn goes on in the background and posts when it ends.
        slot.status = 'waiting-approval'
        round.replies.push({ kind: 'approval', botId: member.id, name: member.name, color: member.color, time: Date.now() })
      } else if (reply?.working) {
        slot.status = 'working'
        round.replies.push({ kind: 'working', botId: member.id, name: member.name, color: member.color, time: Date.now() })
      } else if (final !== undefined || (typeof reply === 'string' && said.length > 0)) {
        slot.status = 'posted'
        if (final !== undefined) postInRound(room, round, member, final)
      } else {
        slot.status = typeof reply === 'string' ? 'passed' : 'missed'
        round.passed.push(member.name)
        if (reply?.missed) {
          round.replies.push({ kind: 'missed', botId: member.id, name: member.name, color: member.color, time: Date.now() })
          // The round moved on without this member: the log shows the call and then
          // silence, which reads as a lost message. The group is told the baton was
          // dropped, and what brings the member back.
          appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `${member.name} did not answer within ${Math.round(ROOM_REPLY_TIMEOUT_MS / 60000)} minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.` })
        }
      }
      const spoken = final === undefined ? said : [...said, final]
      if (spoken.length === 0) continue
      // Only the admin's "@all" calls everyone, so a member cannot set off a storm.
      const leads = rt.isAdminOf(room, member.id)
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const others = everyone.filter(other => other.id !== member.id)
      const { all, found: named } = mentionsIn(spoken.join('\n\n'), everyone)
      const found = named.filter(other => other.id !== member.id)
      // A dispatch calls the member that starts; the ones it names for a later step
      // wait for the hand-off, so they do not begin their own work in the same round
      // (openingSpeakers holds the same rule for the post that opens one).
      let callees = found
      if (dispatches(room, member.id) && !all && found.length > 1) {
        callees = found.slice(0, 1)
        round.standby = [...new Set([...(round.standby ?? []), ...found.slice(1).map(bot => bot.id)])]
      }
      if (leads && all) callees = [...callees, ...others.filter(other => !callees.includes(other))]
      callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? ROOM_ADMIN_TURNS_EACH : ROOM_TURNS_EACH, member.id)
      noteDropped(room, round)
    }
    // Members a dispatch named for a later step that no hand-off ever called: the
    // round ended with the work unfinished, which reads as a lost message. The group
    // is told, as it is for a call the turn limit dropped (noteDropped).
    if (!signal.aborted) {
      const uncalled = (round.standby ?? []).filter(id => !round.slots.some(slot => slot.id === id))
      if (uncalled.length > 0) {
        for (const id of uncalled) {
          const bot = rt.botOf(id)
          if (bot === undefined) continue
          appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `@${bot.name} was named for a later step but was not called: this round ended without a hand-off to it. Whoever holds the next step can call it with @${bot.name}.` })
        }
        void rt.save().catch(() => {})
      }
    }
  }

  ctx.tools.register(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots in this group chat, one at a time, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      const startSeq = room.seq + 1
      // The opening greeting is a cue for the admin, not a line of the group; a member's
      // late failure, its work picked up after a restart, its work the user stopped, or
      // the end of work whose result it already posted is an event of the round.
      const event = item => item.failed || item.resumed || item.stopped || item.done
      for (const post of posts.filter(item => !item.kickoff && !event(item))) {
        // Image readings go into the log only; `@` names are picked from what the user typed.
        // A file stays with its line and reaches each member the line is shown to.
        const readings = post.images === undefined ? [] : await rt.imagesForGroup(post.images, room.id)
        const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        appendRoom(room, {
          ...(post.botId ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId } : { who: 'User' }),
          text,
          ...(post.files === undefined ? {} : { files: post.files }),
        })
      }
    // The user wrote here, so late results may call members again and the quiet
    // notice may be told again: the count and the notice reset together, as they
    // do for a message that waited in the inbox (drainRoomInbox).
    if (posts.some(post => !post.botId && !post.kickoff)) resumeForUser(room)
      await rt.save()
      // An event post never picks the speakers over a message queued with it.
      const opener = posts.findLast(post => !event(post)) ?? posts.at(-1)
      const references = posts.flatMap(post => post.references ?? [])
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members.map(rt.botOf).filter(Boolean)).found
      // A staged plan waits for a word from the user or the admin: the work is
      // agreed before it starts, so the reply to a plan is what runs it.
      const prepared = await applyPlanWord(room, opener)
      let { speakers, standby, plan } = openingSpeakers(room, opener)
      if (prepared?.approved) {
        // Approved work runs in the plan's order, one worker at a time: the
        // first step speaks and the rest wait for its hand-off, which is what
        // the plan was for.
        const members = prepared.steps.map(step => rt.botOf(step.botId)).filter(Boolean)
        speakers = members.slice(0, 1)
        standby = members.slice(1)
        plan = undefined
      } else if (prepared?.rejected) {
        speakers = []
        standby = []
        plan = undefined
      }
      // One live turn per Bot, counted across rooms: a member working somewhere
      // else - another group's round, or its own chat with the user - waits here
      // too, so this round never stalls on another room's work. A member working
      // in THIS room is the hand-off the round is built for: its message queues
      // and its answer comes back late, which is how work is handed on.
      // The dispatch staged work instead of starting it: the group is shown the
      // plan, and the round runs nobody until the plan is approved.
      if (plan !== undefined) {
        const { plan: staged, revised } = rt.stagePlan(room, opener, plan.members)
        if (revised) {
          appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `批准前方案已修改（共有 ${staged.revisions.length} 次修订记录在案）：${planText(staged)}` })
          rt.emitEvent(room.id, 'plan.revised', { id: staged.id, steps: staged.steps.map(step => step.name), revisions: staged.revisions.length })
        } else {
          appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `方案已拟定，批准后才会派人：${planText(staged)}` })
          rt.emitEvent(room.id, 'plan.staged', { id: staged.id, steps: staged.steps.map(step => step.name) })
        }
        await rt.save()
      }

      const busy = speakers.filter(member => {
        const here = room.sessions?.[member.id]
        return rt.activeSessions(member.id).running.some(sessionId => sessionId !== here)
      })
      if (busy.length > 0) {
        speakers = speakers.filter(member => !busy.includes(member))
        // A working member was called first, so it keeps its place at the head of
        // the waiting list, ahead of the ones that followed it.
        standby = [...busy, ...standby]
        appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `@${busy.map(bot => bot.name).join(' and @')} was still working in another chat, so this round went on without ${busy.length > 1 ? 'them' : 'it'}.` })
      }
      const round = {
        roomId: room.id,
        members: room.members,
        startSeq,
        ...(opener.kickoff ? { kickoff: true } : {}),
        ...(references.length > 0 ? { references, shown: [] } : {}),
        slots: speakers.map(member => ({
          id: member.id, name: member.name, status: 'waiting',
          ...(opener.kickoff ? { note: 'the group was just created' } : {}),
          ...(named.includes(member) ? { by: opener.botId } : {}),
          ...(opener.done ? { note: `${opener.name ?? 'a member'} finished the work you asked for` } : {}),
        })),
        standby: standby.map(bot => bot.id),
        ...(asksAcknowledgementOnly(opener.text) ? { ackOnly: true } : {}),
        speaking: null,
        turns: 0,
        replies: [],
        passed: [],
        failed: [],
        started: [],
      }
      for (const post of posts.filter(item => item.failed)) {
        const bot = rt.botOf(post.botId)
        const { code, status, message } = post.failed
        round.failed.push(bot?.name ?? post.name)
        round.replies.push({ kind: 'failed', botId: post.botId, name: bot?.name ?? post.name, color: bot?.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      }
      // The log line tells the admin and the other members on their next turn.
      for (const post of posts.filter(item => item.resumed || item.stopped || item.done)) {
        const bot = rt.botOf(post.botId)
        const name = bot?.name ?? post.name
        const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
        appendRoom(room, { who: name, botId: post.botId, kind, text: '' })
        round.replies.push({ kind, botId: post.botId, name, color: bot?.color, time: Date.now() })
      }
      if (posts.some(post => post.resumed || post.stopped || post.done)) await rt.save()
      rt.roomProgress.set(exec.callId, round)
      // The round's shape, for the panel and for a restart that finds it later:
      // who speaks, in what order, and who was named but waits for a hand-off.
      rt.emitEvent(room.id, 'round.start', {
        callId: exec.callId,
        ...(opener.kickoff ? { kickoff: true } : {}),
        slots: round.slots.map(slot => ({ id: slot.id, name: slot.name, ...(slot.by ? { by: slot.by } : {}) })),
        standby: rt.eventStandbyNames(room, round.standby),
      })
      try {
        await runRound(room, round, exec.signal, exec.agent)
      } catch (error) {
        rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
      } finally {
        rt.roomProgress.delete(exec.callId)
      }
      // Work that was agreed and then run is finished when its round is.
      for (const plan of Object.values(rt.state.plans ?? {})) {
        if (plan.roomId === room.id && plan.status === 'running') rt.finishPlan(plan)
      }
      rt.emitEvent(room.id, 'round.end', {
        callId: exec.callId,
        replies: round.replies.length,
        passed: round.passed.map(bot => bot.name ?? bot.id),
        ...(round.failed.length > 0 ? { failed: round.failed } : {}),
      })
      if (exec.signal?.aborted) {
        const started = round.started.map(turn => ({ sessionId: room.sessions?.[turn.botId] ?? turn.sessionId, exchangeId: turn.exchangeId }))
        for (const turn of started) void rt.stopRoomTurn?.(turn.sessionId, turn.exchangeId)
        // Two stages: the cancels are the first. The wait is bounded and off this
        // round's own return - the next round already holds back a member that is
        // still working - so the convergence is recorded, not waited for here.
        void rt.convergeSessions(started.map(turn => turn.sessionId), { timeoutMs: 10000 })
          .then(({ still }) => rt.emitEvent(room.id, 'stop.converged', { stopped: started.length, still: still.length }))
          .catch(() => {})
      }
      await rt.save()
      for (const post of posts) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, round)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  ctx.tools.register(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(botId)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        ensureRoomLog(room)
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        appendRoom(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        for (const round of rt.roomProgress.values()) {
          if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
        }
        void rt.save().catch(() => {})
      }
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: {
      group: GROUP_REF,
      seq: { type: 'integer', description: 'Read one message whole: the seq that a cut message names' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      await loadGroupLines(room)
      if (args.seq !== undefined) {
        const line = room.log.find(entry => entry.seq === Number(args.seq))
        if (line === undefined) return `"${room.name}" no longer keeps message ${args.seq}; it keeps its latest ${ROOM_LOG_MAX}.`
        const whole = lineText(line, memberText(room)(line))
        // One audit source: what was read, and its digest, so a later claim
        // about this line can be checked against what it really was.
        rt.auditRead({ roomId: room.id, botId: self, kind: 'line', text: whole, seq: Number(args.seq) })
        void rt.save().catch(() => {})
        return whole
      }
      // Thirty whole lines could fill the context, so a long one shows its start.
      const short = (line) => {
        const length = line.length ?? line.text.length
        return length <= TEXT_KEPT ? line.text : `${headOf(line.text, TEXT_KEPT)}… (cut; ${length} characters in all; read_group_chat with seq ${line.seq} reads it whole)`
      }
      const lines = room.log.slice(-ROOM_READ_MAX)
      if (lines.length === 0) return `"${room.name}" has no messages yet.`
      const seen = `Latest in "${room.name}" (oldest first):\n${transcript(lines, short)}`
      // The same source records the whole-list read: the span it covered and a
      // digest of the text it was actually shown, cuts and all.
      rt.auditRead({
        roomId: room.id, botId: self, kind: 'chat', text: seen,
        ...(lines.length > 0 ? { from: lines[0].seq, to: lines.at(-1).seq } : {}),
      })
      void rt.save().catch(() => {})
      return seen
    },
  }))

  // The admin dispatches the work of a group; a member hands it off. A Main Bot that
  // is not this group's admin still dispatches when it posts into the group.
  const dispatches = (room, botId) => botId !== undefined && (rt.isAdminOf(room, botId) || rt.isMain(botId))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone. What a member posts
  // after its round moved on is answered by the member that asked for it; work the
  // user asked for is left for the user to read.
  //
  // A dispatch names the member that starts and the ones that follow it: only the
  // first is called, the rest wait for the hand-off. On 2026-10-23 the code reviewer
  // began its own review while the developer was still working, because the dispatch
  // "@开发工程师 派单 … @代码审查员 待命等确认" woke both; the finisher's own "@Name"
  // brings the next one in, with the result in the log it reads. The user's own
  // message calls everyone it names, and so does a member's hand-off.
  function openingSpeakers(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    if (opener.kickoff) return { speakers: admin ? [admin] : [], standby: [] }
    // A halted room answers nobody until it is resumed: a member's post keeps its
    // place in the log, but its "@" names call nobody, as with a late post past
    // the round limit. The user's own message resumes the room before it is read.
    if (opener.quiet || (rt.isHalted(room) && opener.botId !== undefined)) return { speakers: [], standby: [] }
    if (opener.done) return { speakers: members.filter(bot => bot.id === opener.askedBy), standby: [] }
    const { all, found: named } = mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.progress) return { speakers: found, standby: [] }
    if (opener.late) return { speakers: found.length > 0 ? found : members.filter(bot => bot.id === opener.askedBy), standby: [] }
    if (found.length > 0 && !all) {
      if (dispatches(room, opener.botId)) {
        // Two or more workers named by one dispatch: the work is a plan first.
        // Nobody starts until the plan is approved, so a reviewer never begins
        // before the work it is meant to review.
        if (found.length > 1) return { speakers: [], standby: [], plan: { members: found, by: opener.botId, text: opener.text } }
        return { speakers: [found[0]], standby: found.slice(1) }
      }
      return { speakers: found, standby: [] }
    }
    if (!all && room.mode === 'admin' && admin) return { speakers: [admin], standby: [] }
    return { speakers: admin ? [admin, ...members.filter(bot => bot !== admin)] : members, standby: [] }
  }

  // A Bot's message into the group's own Session, which relays it as a new round.
  async function postToRoom(room, sender, text, extra = {}, files = []) {
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }, ...files.map(attachment => ({ type: 'file', attachment }))],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...extra },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.postToRoom = postToRoom

  // Past the late-round limit every later post is quiet: its "@" names call nobody,
  // while the log still shows them. Members would keep handing work to a room that
  // no longer answers, so the group is told once when the limit is reached; the
  // user's next message resets the count (drainRoomInbox) and it may be told again.
  // The room is HALTED, with the limit as the reason: a decision to stop reads
  // differently from a loop that ran out of room, and a resume says which lifted it.
  const noteQuiet = (room) => {
    if (room.quietNoticed === true) return
    room.quietNoticed = true
    appendRoom(room, { who: 'DS Bot', kind: 'notice', text: `The group is in quiet mode: late replies after work have reached the ${ROOM_LATE_ROUNDS}-round limit, so @ names in later posts call nobody, though the messages still reach the log. The user can reset it by writing here, or the current work can finish.` })
    rt.haltRoom(room, { kind: rt.HALT_LATE, reason: `late replies reached the ${ROOM_LATE_ROUNDS}-round limit` })
    rt.emitEvent(room.id, 'halted', { kind: rt.HALT_LATE, reason: room.haltedReason })
    void rt.save().catch(() => {})
  }

  // The user wrote here, so the room answers again: a halt the late-round limit
  // caused is lifted by the message itself, and the record says so.
  const resumeForUser = (room) => {
    room.lateRounds = 0
    room.quietNoticed = false
    if (rt.isHalted(room)) {
      rt.resumeRoom(room, { reason: 'the user wrote here' })
      rt.emitEvent(room.id, 'resumed', { reason: room.resumedReason })
    }
    void rt.save().catch(() => {})
  }

  // A member the round moved on from (it went on working, went quiet or waited for an
  // approval) posts what its turn ended with. The member that asked for it and anyone
  // it names answer; past the late round limit nobody does, so late posts cannot keep a
  // group talking. Work whose result already went out as a step line (`shown`) and
  // that ends with nothing more to say still tells the member that asked for it, which
  // answers the result: where the result sits in the turn decides nothing.
  async function lateRoomReply(sessionId, info, reply, { shown = false } = {}) {
    if (refuseRetired(sessionId, info)) return
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, reply)
    const done = isPass(text) && shown && info.askedBy !== undefined
    if (isPass(text) && !done) return
    const quiet = (room.lateRounds ?? 0) >= ROOM_LATE_ROUNDS
    if (quiet) noteQuiet(room)
    else room.lateRounds = (room.lateRounds ?? 0) + 1
    await rt.save()
    rt.emitEvent(room.id, 'late-reply', { name: member.name, ...(done ? { done: true } : {}), ...(quiet ? { quiet: true } : {}) })
    await postToRoom(room, member, done ? '' : text, { late: true, ...(done ? { done: true } : {}), ...(info.askedBy ? { askedBy: info.askedBy } : {}), ...(quiet ? { quiet: true } : {}) })
      .catch(error => rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error))
  }
  rt.lateRoomReply = lateRoomReply

  const memberIn = (sessionId, info) => {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info?.roomId)
    const member = rt.botOf(owner?.botId)
    return room !== undefined && member !== undefined && room.members.includes(member.id) ? { room, member } : undefined
  }
  // A Bot deleted while its work was still running: the answer it was writing is
  // refused where it would land, and the group is told, rather than dropped in
  // silence. True when the session is one the team retired.
  const refuseRetired = (sessionId, info) => {
    if (!rt.isRetired(rt.state, sessionId)) return false
    const room = rt.roomOf(info?.roomId)
    if (room === undefined) return false
    const gone = rt.state.retiredSessions[sessionId]?.name ?? 'a removed Bot'
    rt.emitEvent(room.id, 'retired.refused', { name: gone })
    rt.warn('ds-bot: a late post from the removed Bot %s in %s was refused', gone, room.name)
    return true
  }
  const callsIn = (room, member, text) => mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.some(bot => bot.id !== member.id)

  // What a member says while it works, into the group. While the member holds its place
  // in a round, it joins that round. Later, it joins whatever round runs in the group, or
  // posts on its own. Only the members it calls with @ answer it, and not past the late
  // round limit; the member that asked for the work answers the result.
  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    if (refuseRetired(sessionId, info)) return
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    ensureRoomLog(room)
    const calls = callsIn(room, member, text)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) return postInRound(room, running, member, text)
    const limited = (room.lateRounds ?? 0) >= ROOM_LATE_ROUNDS
    if (limited) noteQuiet(room)
    const quiet = !calls || limited
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await rt.save()
    await postToRoom(room, member, text, { progress: true, ...(quiet ? { quiet: true } : {}) })
  }

  // Lines a member writes close together reach the group as one message, so a burst of
  // steps does not come out as a string of messages. Its first line on work it was asked
  // for and a line that calls a member go at once; lines still held when the turn ends
  // open its result. Per group Session.
  const held = new Map()
  ctx.effect(() => () => { for (const entry of held.values()) clearTimeout(entry.timer) }, 'ds-bot: group step lines')
  const flushSteps = (sessionId) => {
    const entry = held.get(sessionId)
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.lines.length === 0) return undefined
    entry.last = Date.now()
    return postStep(sessionId, entry.info, entry.lines.splice(0).join('\n\n'))
  }
  rt.roomStepText = async (sessionId, info, raw, first) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    const entry = held.get(sessionId) ?? { last: 0, lines: [] }
    held.set(sessionId, entry)
    entry.info = info
    entry.lines.push(text)
    if ((first && info?.role === 'room') || callsIn(room, member, text) || Date.now() - entry.last >= ROOM_STEP_GAP_MS) return flushSteps(sessionId)
    entry.timer ??= setTimeout(() => void flushSteps(sessionId)?.catch(error => rt.warn('ds-bot: step lines from %s not posted: %s', member.name, error)), entry.last + ROOM_STEP_GAP_MS - Date.now())
  }
  rt.takeRoomSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return ''
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.last = Date.now()
    return entry.lines.splice(0).join('\n\n')
  }
  rt.withRoomSteps = (lines, reply) => (lines === '' ? reply : isPass(reply) ? lines : `${lines}\n\n${reply}`)

  // The user stops a member's work in this group from the group's details. Messages
  // still waiting for that member here go with it.
  async function stopMemberWork(roomId, botId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = room?.sessions?.[botId]
    if (room === undefined || member === undefined || sessionId === undefined || rt.live.get(sessionId)?.turn === undefined) return false
    const agent = await rt.resolveAgent(sessionId)
    agent.cancel({ kind: 'user' })
    await postToRoom(room, member, '', { quiet: true, stopped: true })
    return true
  }
  rt.stopMemberWork = stopMemberWork

  // The round said such a member posts when done; a failed model call is how it ended.
  // Nobody answers it.
  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const { code, status, message } = failure
    await postToRoom(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
      late: true, quiet: true, failed: { code, ...(status ? { status } : {}), message },
    }).catch(error => rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error))
  }
  rt.lateRoomFailure = lateRoomFailure

  // A group the user just made opens with its admin asking what the group is for.
  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  async function reportRound(room, post, round) {
    const lines = round.replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const waiting = round.replies.filter(reply => reply.kind === 'approval').map(reply => reply.name)
    const working = round.replies.filter(reply => reply.kind === 'working').map(reply => reply.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; read_group_chat shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.` : '',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    // Replies the poster waited for go on with the work it posted for.
    const work = post.sub === undefined ? undefined : rt.closeWork(post.sub, `Group "${room.name}"`, text)
    await rt.deliver({ toId: post.botId, role: 'report', roomId: room.id, text, ...(work ? { work, replyTo: post.sub } : {}) })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles, and DS Bot's own
  // calls for the room such as image readings, still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      // The relay runs here, inside this stream, instead of as a call handed to
      // the agent loop. The loop dispatches a synthesized call as a scheduled
      // execution, and this host's scheduled path logs without its inject -
      // live 2026-10-25 14:16, "cannot get property randomUUID without inject"
      // took the whole round down before ds-bot ever ran. turns.js queues the
      // opening message before this hook is reached, so an empty queue means
      // there is nothing new to relay.
      const queued = rt.roomInbox.get(options.sessionId) ?? []
      if (queued.length === 0) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const relay = ctx.registeredTools?.get?.('group_relay')
      if (relay !== undefined) {
        try {
          await relay.execute({}, { agent: { id: options.sessionId }, callId: id, signal: options.signal })
        } catch (error) {
          rt.warn('ds-bot: group relay in %s failed: %s', options.sessionId, error?.message ?? error)
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // No inline path (an older host): the synthesized call, as before.
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_relay', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_relay', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
