// The one place that knows what was read, when, and by whom.
//
// A member reads the group's record from three paths - the prompt it is given
// each turn, read_group_chat, and a single cut line read by seq - and every one
// of them used its own slice of the log with nothing on record. When a member
// says "I checked it", there was no way to tell what it actually read, or
// whether that was still what the group holds.
//
// Every read now goes through auditRead: the reader, the room, the span it
// covered, and a digest of exactly the text it was shown. The digest is the
// handle the rest of the host uses - a later claim about the material can be
// checked against it, and "the draft changed under it" is a fact rather than
// an argument.
import { createHash } from 'node:crypto'

export const AUDITS_KEPT = 500
// How much of a digest a reader or the panel ever sees: short enough to quote,
// long enough that a collision is not something to plan for.
export const DIGEST_CHARS = 16

export const digestOf = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, DIGEST_CHARS)

export function install(rt) {
  const auditRead = ({ roomId, botId = null, kind, text, from = null, to = null, seq = null }) => {
    rt.state.audits ??= []
    const entry = {
      at: Date.now(), roomId, botId, kind,
      digest: digestOf(text), chars: String(text ?? '').length,
      ...(seq !== null ? { seq } : {}),
      ...(from !== null ? { from, to } : {}),
    }
    rt.state.audits.push(entry)
    if (rt.state.audits.length > AUDITS_KEPT) rt.state.audits = rt.state.audits.slice(-AUDITS_KEPT)
    return entry
  }

  // What the panel and the state endpoint show: the room's reads, newest last,
  // with the reader's name rather than its id.
  const auditsView = roomId => (rt.state.audits ?? [])
    .filter(entry => roomId === undefined || entry.roomId === roomId)
    .map(({ ...entry }) => ({ ...entry, by: entry.botId === null ? 'the user' : rt.botOf(entry.botId)?.name ?? entry.botId }))

  // The digest a reading covered, which is what a claim about it is checked
  // against; undefined when nothing was read with that span.
  const digestFor = (roomId, seq) => [...(rt.state.audits ?? [])].reverse()
    .find(entry => entry.roomId === roomId && entry.seq === seq)?.digest

  Object.assign(rt, { auditRead, auditsView, digestFor, digestOf })
}
