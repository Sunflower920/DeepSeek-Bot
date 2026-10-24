// DSH's file addresses, the way DSH encodes its own: a path under the file resource,
// segment by segment, with a drive letter's colon left literal. The session scope is
// what DSH's chat hands its file viewer — the sidebar tab claims that scope, not the
// absolute one — and the Session resolves an absolute path against its workspace.
const encodeSegment = segment => encodeURIComponent(segment).replace(/%3A/gi, ':')
const encodePath = path => path.replace(/\\/g, '/').split('/').map(encodeSegment).join('/')

// `dsh-resource://file/session/<sessionId>/<path>`, the address the sidebar opens.
export const fileSessionAddress = (sessionId, path) => `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(path)}`

// `dsh-resource://file/absolute/<path>`, the same path without a Session around it.
export const fileAddress = path => `dsh-resource://file/absolute/${encodePath(path)}`
