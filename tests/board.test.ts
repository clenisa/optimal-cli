import test from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Project, Task, Label, Comment, Milestone, ActivityEntry,
  CreateProjectInput, CreateTaskInput, CreateCommentInput, CreateMilestoneInput,
  UpdateTaskInput, TaskStatus,
} from '../lib/board/types.ts'

// --- Mock builder ---

function mockSupabase(handlers: Record<string, Function>) {
  let lastTable = ''
  const chain: Record<string, Function> = {
    from(table: string) { lastTable = table; return chain },
    select() { return chain },
    insert(data: any) { return chain },
    update(data: any) { return chain },
    delete() { return chain },
    upsert(data: any) { return chain },
    eq(col: string, val: any) { return chain },
    neq(col: string, val: any) { return chain },
    in(col: string, vals: any[]) { return chain },
    is(col: string, val: any) { return chain },
    not(col: string, op: string, val: any) { return chain },
    contains(col: string, val: any) { return chain },
    order(col: string, opts?: any) { return chain },
    limit(n: number) { return chain },
    single() {
      const h = handlers[`${lastTable}.single`]
      return h ? h() : { data: null, error: { message: 'not found' } }
    },
    then(resolve: Function) {
      const h = handlers[`${lastTable}.list`] ?? handlers[`${lastTable}.mutate`]
      const result = h ? h() : { data: [], error: null }
      return resolve(result)
    },
  }
  // Make chain thenable for await
  ;(chain as any)[Symbol.for('nodejs.util.inspect.custom')] = () => 'MockChain'
  return chain as unknown as SupabaseClient
}

// Import after mock setup
let board: typeof import('../lib/board/index.ts')

test('board module loads', async () => {
  board = await import('../lib/board/index.ts')
  assert.ok(board)
  assert.ok(typeof board.createProject === 'function')
  assert.ok(typeof board.createTask === 'function')
  assert.ok(typeof board.claimTask === 'function')
  assert.ok(typeof board.addComment === 'function')
  assert.ok(typeof board.listTasks === 'function')
  assert.ok(typeof board.logActivity === 'function')
})

test('formatBoardTable returns formatted string', async () => {
  const tasks: Task[] = [
    {
      id: '1', project_id: 'p1', milestone_id: null, title: 'Test task',
      description: null, status: 'ready', priority: 2, assigned_to: null,
      claimed_by: null, claimed_at: null, skill_required: 'config-sync',
      source_repo: null, target_module: null, estimated_effort: 'm',
      blocked_by: [], sort_order: 0, created_at: '', updated_at: '', completed_at: null,
    },
  ]
  const output = board.formatBoardTable(tasks)
  assert.ok(output.includes('Test task'))
  assert.ok(output.includes('ready'))
  assert.ok(output.includes('config-sync'))
})

test('formatBoardTable handles empty list', async () => {
  const output = board.formatBoardTable([])
  assert.ok(output.includes('No tasks'))
})

test('getNextClaimable filters by blocked_by', async () => {
  const tasks: Task[] = [
    {
      id: 'blocked-1', project_id: 'p1', milestone_id: null, title: 'Blocked',
      description: null, status: 'ready', priority: 1, assigned_to: null,
      claimed_by: null, claimed_at: null, skill_required: null,
      source_repo: null, target_module: null, estimated_effort: null,
      blocked_by: ['dep-not-done'], sort_order: 0,
      created_at: '', updated_at: '', completed_at: null,
    },
    {
      id: 'free-1', project_id: 'p1', milestone_id: null, title: 'Free',
      description: null, status: 'ready', priority: 2, assigned_to: null,
      claimed_by: null, claimed_at: null, skill_required: null,
      source_repo: null, target_module: null, estimated_effort: null,
      blocked_by: [], sort_order: 0,
      created_at: '', updated_at: '', completed_at: null,
    },
  ]
  const allTasks = [...tasks, {
    id: 'dep-not-done', project_id: 'p1', milestone_id: null, title: 'Dep',
    description: null, status: 'in_progress', priority: 1, assigned_to: null,
    claimed_by: null, claimed_at: null, skill_required: null,
    source_repo: null, target_module: null, estimated_effort: null,
    blocked_by: [], sort_order: 0,
    created_at: '', updated_at: '', completed_at: null,
  }]
  const next = board.getNextClaimable(tasks, allTasks)
  assert.ok(next)
  assert.equal(next!.id, 'free-1')
})

test('getNextClaimable returns null when all blocked', async () => {
  const tasks: Task[] = [
    {
      id: 'blocked-1', project_id: 'p1', milestone_id: null, title: 'Blocked',
      description: null, status: 'ready', priority: 1, assigned_to: null,
      claimed_by: null, claimed_at: null, skill_required: null,
      source_repo: null, target_module: null, estimated_effort: null,
      blocked_by: ['dep-not-done'], sort_order: 0,
      created_at: '', updated_at: '', completed_at: null,
    },
  ]
  const next = board.getNextClaimable(tasks, tasks)
  assert.equal(next, null)
})
