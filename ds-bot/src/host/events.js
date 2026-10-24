// Round lifecycle events: the durable record of what a group round was doing.
// Every mutation of a round's shape (it starts with its speaking order, a member
// answers late, the group goes quiet, a standby member is dropped) appends one
// line to the room, so a restart can replay the round instead of guessing from
// the log, and the panels and the cold-restart audit read the same record.
//
// The ring is bounded per room: a long-lived group keeps its recent lifecycle,
// not every round it ever ran. The room log is the transcript; this is the shape.
import { nameKey } from '../shared/mentions.js'

// How many events one room keeps. Old enough to outlive any panel's patience,
// small enough that state.json stays a state file.
export const EVENT_RING = 200

export function install(rt) {
  // One line, in the room, under its own sequence number. The caller saves; an
  // event is a state change like any other.
  const emit = (roomId, type, fields = {}) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return undefined
    if (room.events === undefined) room.events = []
    const seq = (room.eventSeq ?? 0) + 1
    const line = { seq, at: Date.now(), type, ...fields }
    room.events.push(line)
    room.eventSeq = seq
    if (room.events.length > EVENT_RING) room.events.splice(0, room.events.length - EVENT_RING)
    return line
  }
  // Events after a sequence number, oldest first: a panel passes the last one it
  // saw and gets only what is new.
  const eventsOf = (roomId, since = 0) => {
    const room = rt.roomOf(roomId)
    if (room?.events === undefined) return []
    return room.events.filter(line => line.seq > since)
  }
  Object.assign(rt, { emitEvent: emit, roomEventsOf: eventsOf })

  // A standby member the round never called is named in the notice the group
  // gets, and here, so the panel can show the drop where it happened.
  const standbyNames = (room, ids = []) => ids.map(id => rt.botOf(id)?.name ?? id)
  rt.eventStandbyNames = standbyNames
  // The key a name resolves by, exported for callers that check collisions.
  rt.nameKey = nameKey
}
