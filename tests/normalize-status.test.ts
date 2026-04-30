import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStatus, TASK_STATUSES, type TaskStatus } from '../lib/board/types.js'

describe('normalizeStatus', () => {
  it('passes through canonical statuses', () => {
    for (const s of TASK_STATUSES) {
      assert.equal(normalizeStatus(s), s)
    }
  })

  it('aliases in_review → review (regression: -s in_review used to crash)', () => {
    assert.equal(normalizeStatus('in_review'), 'review' satisfies TaskStatus)
    assert.equal(normalizeStatus('in-review'), 'review')
    assert.equal(normalizeStatus('IN_REVIEW'), 'review')
    assert.equal(normalizeStatus(' in_review '), 'review')
  })

  it('aliases other natural-language forms', () => {
    assert.equal(normalizeStatus('todo'), 'backlog')
    assert.equal(normalizeStatus('to_do'), 'backlog')
    assert.equal(normalizeStatus('wip'), 'in_progress')
    assert.equal(normalizeStatus('inprogress'), 'in_progress')
  })

  it('throws a helpful error on unrecognised statuses', () => {
    try {
      normalizeStatus('shipped')
      assert.fail('expected throw')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /Invalid status "shipped"/)
      assert.match(msg, /backlog, ready/)
    }
  })
})
