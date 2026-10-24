// DSH's file addresses: an absolute path under the file resource's `absolute` scope,
// encoded segment by segment the way DSH encodes its own (drive-letter colons stay
// literal). The right sidebar's openResource then reads the file where it sits.
export const fileAddress = path => `dsh-resource://file/absolute/${path.replace(/\\/g, '/').split('/').map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')}`
