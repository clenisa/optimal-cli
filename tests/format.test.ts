import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import {
  colorize,
  table,
  statusBadge,
  priorityBadge,
  success,
  error,
  warn,
  info,
} from '../lib/format.js'

describe('format', () => {
  describe('colorize', () => {
    it('wraps text in ANSI codes', () => {
      const result = colorize('hello', 'red')
      assert.match(result, /\x1b\[31mhello\x1b\[39m/)
    })

    it('returns plain text when NO_COLOR is set', () => {
      const prev = process.env.NO_COLOR
      process.env.NO_COLOR = '1'
      const result = colorize('hello', 'red')
      assert.strictEqual(result, 'hello')
      if (prev) process.env.NO_COLOR = prev
      else delete process.env.NO_COLOR
    })

    it('supports all color keys', () => {
      const colors = ['red', 'green', 'yellow', 'blue', 'cyan', 'gray', 'bold', 'dim'] as const
      for (const c of colors) {
        const result = colorize('test', c)
        assert.ok(result.includes('test'), `should contain text for ${c}`)
      }
    })
  })

  describe('table', () => {
    it('renders headers and rows correctly', () => {
      const headers = ['Name', 'Age']
      const rows = [['Alice', '30'], ['Bob', '25']]
      const result = table(headers, rows)
      assert.ok(result.includes('Name'))
      assert.ok(result.includes('Age'))
      assert.ok(result.includes('Alice'))
      assert.ok(result.includes('Bob'))
    })

    it('handles empty rows', () => {
      const headers = ['Col1', 'Col2']
      const result = table(headers, [])
      assert.ok(result.includes('Col1'))
      assert.ok(result.includes('Col2'))
    })

    it('handles missing cell values', () => {
      const headers = ['A', 'B', 'C']
      const rows = [['1'], ['1', '2']]
      const result = table(headers, rows)
      assert.ok(result.includes('A'))
      assert.ok(result.includes('B'))
      assert.ok(result.includes('C'))
    })
  })

  describe('statusBadge', () => {
    it('returns colored badge for known statuses', () => {
      const statuses = ['done', 'in_progress', 'blocked', 'ready', 'backlog', 'cancelled', 'review']
      for (const s of statuses) {
        const result = statusBadge(s)
        assert.ok(result.includes(s), `should contain status: ${s}`)
      }
    })

    it('defaults to dim for unknown status', () => {
      const result = statusBadge('unknown_status')
      assert.ok(result.includes('unknown_status'))
    })
  })

  describe('priorityBadge', () => {
    it('returns colored P1-P4 badges', () => {
      assert.ok(priorityBadge(1).includes('P1'))
      assert.ok(priorityBadge(2).includes('P2'))
      assert.ok(priorityBadge(3).includes('P3'))
      assert.ok(priorityBadge(4).includes('P4'))
    })

    it('defaults to gray for unknown priority', () => {
      const result = priorityBadge(99)
      assert.ok(result.includes('P99'))
    })
  })
})