import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileAddress } from '../src/client/file-address.js'

// The address DSH's file viewer reads: `dsh-resource://file/absolute/…`, one segment
// per path part, with the encoding DSH applies to its own addresses.
test('a file address encodes a native path the way DSH does', () => {
  assert.equal(fileAddress('D:\\work\\群\\report.docx'), 'dsh-resource://file/absolute/D:/work/%E7%BE%A4/report.docx')
  assert.equal(fileAddress('D:/work/report.docx'), 'dsh-resource://file/absolute/D:/work/report.docx')
  assert.equal(fileAddress('D:/a b/f.txt'), 'dsh-resource://file/absolute/D:/a%20b/f.txt')
  // DSH unescapes every colon in a segment, drive letter or not; a parser decodes
  // the segment back, so the address still round-trips.
  assert.equal(fileAddress('D:/x:y/z.txt'), 'dsh-resource://file/absolute/D:/x:y/z.txt')
  // No trailing separator, whatever the spelling that came in.
  assert.equal(fileAddress('C:/a\\b\\c'), 'dsh-resource://file/absolute/C:/a/b/c')
})
