import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nameKey, nameProblem } from '../src/shared/mentions.js'

// One canonical key stands for one name: the lookups fall back to it, and creating
// a second spelling of a live name is refused (see roster tests).
test('a name key folds case, spacing, dashes and width', () => {
  assert.equal(nameKey('Dev Lead'), 'devlead')
  assert.equal(nameKey('dev-lead'), 'devlead')
  assert.equal(nameKey('dev.lead'), 'devlead')
  assert.equal(nameKey('  dev   lead  '), 'devlead')
  assert.equal(nameKey('ＤＥＶ'), 'dev', 'full-width letters fold to ASCII')
  assert.equal(nameKey('狗蛋'), '狗蛋')
  // Invisible characters fold away, so a name with them is the same name.
  assert.equal(nameKey('dev\u200blead'), 'devlead')
  assert.equal(nameKey(''), '')
  assert.equal(nameKey(undefined), '')
})

test('a name refuses what a reader cannot tell apart', () => {
  assert.match(nameProblem('dev\u200b'), /invisible characters/)
  assert.match(nameProblem('a@b'), /cannot contain @/)
  assert.match(nameProblem('all'), /calls everyone/)
  assert.equal(nameProblem('Dev Lead'), undefined)
})
