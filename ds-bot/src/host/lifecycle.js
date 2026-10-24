// The lifecycle vocabulary a group and its members share.
//
// A room is active, or halted with a reason a reader can act on: the user (or a
// Main Bot) stopped it, or late replies reached the round limit on their own.
// The two are not the same thing - one is a decision, the other is a loop that
// ran out of room - so the record says which, and a resume says why.
//
// A member that left the team keeps a deny-list entry: a session that wakes up
// after its Bot was deleted is refused with a word in the log, not silently
// dropped, so a restart can tell "it left" from "it never answered".
export const ROOM_ACTIVE = 'active'
export const ROOM_HALTED = 'halted'

// Why a room is halted. A user halt is a decision; the late-round limit is the
// group's own loop reaching its bound, which the user's next message lifts.
export const HALT_USER = 'user'
export const HALT_LATE = 'late-rounds'

// How many retired sessions a team remembers. Old enough to outlast a restart
// that finds a late wake, small enough that state.json stays a state file.
export const RETIRED_KEPT = 500

export const roomStatus = room => room?.status ?? ROOM_ACTIVE
export const isHalted = room => roomStatus(room) === ROOM_HALTED

// Halt a room with a reason and the time, for the record and the panel.
export function haltRoom(room, { kind = HALT_USER, reason = '' } = {}) {
  room.status = ROOM_HALTED
  room.haltedKind = kind
  room.haltedAt = Date.now()
  room.haltedReason = String(reason ?? '').slice(0, 200)
  return room
}

// Resume: the reason is what a reader needs to tell a deliberate resume from a
// message that merely lifted the late-round limit.
export function resumeRoom(room, { reason = '' } = {}) {
  delete room.status
  delete room.haltedKind
  delete room.haltedAt
  delete room.haltedReason
  room.resumedAt = Date.now()
  room.resumedReason = String(reason ?? '').slice(0, 200)
  room.lateRounds = 0
  room.quietNoticed = false
  return room
}

// Remember a deleted Bot's sessions, so a late wake is refused by name.
export function retireSessions(state, sessions, name) {
  if (state.retiredSessions === undefined) state.retiredSessions = {}
  const at = Date.now()
  for (const sessionId of sessions) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    state.retiredSessions[sessionId] = { name: String(name ?? ''), at }
  }
  const kept = Object.entries(state.retiredSessions).sort(([, a], [, b]) => a.at - b.at).slice(-RETIRED_KEPT)
  state.retiredSessions = Object.fromEntries(kept)
  return state.retiredSessions
}

export const isRetired = (state, sessionId) => state?.retiredSessions?.[sessionId] !== undefined

// The vocabulary rides on `rt` beside the state it reads, so a module never
// imports the lifecycle words from a sibling's path.
export function install(rt) {
  Object.assign(rt, { roomStatus, isHalted, haltRoom, resumeRoom, retireSessions, isRetired, ROOM_ACTIVE, ROOM_HALTED, HALT_USER, HALT_LATE, RETIRED_KEPT })
}
