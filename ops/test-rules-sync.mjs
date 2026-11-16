import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRuleChanges } from './publish-rules.mjs'

test('rule publication preserves unrelated live edits and does not mutate inputs', () => {
  const before = { family: { label: 'Anima', rules: ['old'], cfg: 4 } }
  const desired = { family: { label: 'Anima', rules: ['new'], cfg: 4 }, revision: 'art-1' }
  const current = { family: { label: 'My label', rules: ['old'], cfg: 5 } }
  const original = structuredClone(current)
  assert.deepEqual(mergeRuleChanges(before, desired, current), { family: { label: 'My label', rules: ['new'], cfg: 5 }, revision: 'art-1' })
  assert.deepEqual(current, original)
})

test('rule publication rejects competing edits in the same array and accepts an already applied change', () => {
  assert.throws(() => mergeRuleChanges({ rules: ['old'] }, { rules: ['new'] }, { rules: ['user'] }), /冲突.*\/rules/)
  assert.deepEqual(mergeRuleChanges({ rules: ['old'] }, { rules: ['new'] }, { rules: ['new'] }), { rules: ['new'] })
})

test('rule publication handles removals and prototype-looking keys without changing prototypes', () => {
  assert.deepEqual(mergeRuleChanges({ old: 1, keep: 2 }, { keep: 2 }, { old: 1, keep: 3 }), { keep: 3 })
  const before = JSON.parse('{"__proto__":{"x":1},"label":"old"}')
  const desired = JSON.parse('{"__proto__":{"x":1},"label":"new"}')
  const current = JSON.parse('{"__proto__":{"x":2},"label":"old"}')
  const merged = mergeRuleChanges(before, desired, current)
  assert.equal(Object.getPrototypeOf(merged), Object.prototype)
  assert.equal(Object.hasOwn(merged, '__proto__'), true)
  assert.equal(merged.__proto__.x, 2)
  assert.equal(merged.label, 'new')
  assert.equal({}.x, undefined)
})
