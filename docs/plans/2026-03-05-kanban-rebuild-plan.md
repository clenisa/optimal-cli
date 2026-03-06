# Kanban Board Rebuild — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `cli_tasks/cli_task_logs/cli_projects` with a full project management system (projects, milestones, labels, tasks, comments, activity log) and rewrite the CLI commands + lib module to match.

**Architecture:** Single Supabase migration drops old tables, creates new schema. `lib/board.ts` replaces `lib/kanban.ts` as the data layer. CLI commands under `optimal board`, `optimal project`, `optimal milestone`, `optimal label` wire to the lib. A seed script populates 5 projects, labels, and 33 migration tasks.

**Tech Stack:** TypeScript (ESM, strict), Commander.js, @supabase/supabase-js, node:test + node:assert/strict, tsx

---

### Task 1: Supabase Migration — New Schema

**Files:**
- Create: `supabase/migrations/20260305200000_rebuild_kanban.sql`

**Step 1: Write the migration SQL**

```sql
-- Drop old tables
DROP TABLE IF EXISTS cli_task_logs CASCADE;
DROP TABLE IF EXISTS cli_tasks CASCADE;
DROP TABLE IF EXISTS cli_projects CASCADE;

-- Projects
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','archived')),
  owner text,
  priority int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Milestones
CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  due_date date,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','missed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Labels
CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tasks
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog','ready','claimed','in_progress','review','done','blocked')),
  priority int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  assigned_to text,
  claimed_by text,
  claimed_at timestamptz,
  skill_required text,
  source_repo text,
  target_module text,
  estimated_effort text CHECK (estimated_effort IN ('xs','s','m','l','xl')),
  blocked_by uuid[] DEFAULT '{}',
  sort_order int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Task-Label join
CREATE TABLE task_labels (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

-- Comments
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  comment_type text NOT NULL DEFAULT 'comment'
    CHECK (comment_type IN ('comment','status_change','claim','review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Activity log
CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_claimed ON tasks(claimed_by);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_priority ON tasks(priority, sort_order);
CREATE INDEX idx_comments_task ON comments(task_id);
CREATE INDEX idx_activity_task ON activity_log(task_id);
CREATE INDEX idx_activity_actor ON activity_log(actor);
CREATE INDEX idx_milestones_project ON milestones(project_id);

-- updated_at triggers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_milestones_updated BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: service_role full access
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON projects FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON milestones FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON labels FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON task_labels FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON comments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON activity_log FOR ALL TO service_role USING (true) WITH CHECK (true);
```

**Step 2: Run migration**

```bash
cd /home/oracle/repos/optimal-cli
supabase db push --linked
```

Expected: Migration applies cleanly; old tables dropped, new tables created.

**Step 3: Commit**

```bash
git add supabase/migrations/20260305200000_rebuild_kanban.sql
git commit -m "feat: rebuild kanban schema with projects, milestones, labels, comments, activity log"
```

---

### Task 2: Types — `lib/board/types.ts`

**Files:**
- Create: `lib/board/types.ts`

**Step 1: Write the types**

```typescript
export interface Project {
  id: string
  slug: string
  name: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'archived'
  owner: string | null
  priority: 1 | 2 | 3 | 4
  created_at: string
  updated_at: string
}

export interface Milestone {
  id: string
  project_id: string
  name: string
  description: string | null
  due_date: string | null
  status: 'open' | 'completed' | 'missed'
  created_at: string
  updated_at: string
}

export interface Label {
  id: string
  name: string
  color: string | null
  created_at: string
}

export type TaskStatus = 'backlog' | 'ready' | 'claimed' | 'in_progress' | 'review' | 'done' | 'blocked'
export type Priority = 1 | 2 | 3 | 4
export type Effort = 'xs' | 's' | 'm' | 'l' | 'xl'

export interface Task {
  id: string
  project_id: string
  milestone_id: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  assigned_to: string | null
  claimed_by: string | null
  claimed_at: string | null
  skill_required: string | null
  source_repo: string | null
  target_module: string | null
  estimated_effort: Effort | null
  blocked_by: string[]
  sort_order: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Comment {
  id: string
  task_id: string
  author: string
  body: string
  comment_type: 'comment' | 'status_change' | 'claim' | 'review'
  created_at: string
}

export interface ActivityEntry {
  id: string
  task_id: string | null
  project_id: string | null
  actor: string
  action: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  created_at: string
}

// --- Input types ---

export interface CreateProjectInput {
  slug: string
  name: string
  description?: string
  owner?: string
  priority?: Priority
}

export interface CreateMilestoneInput {
  project_id: string
  name: string
  description?: string
  due_date?: string
}

export interface CreateTaskInput {
  project_id: string
  title: string
  description?: string
  priority?: Priority
  milestone_id?: string
  skill_required?: string
  source_repo?: string
  target_module?: string
  estimated_effort?: Effort
  blocked_by?: string[]
  labels?: string[]
}

export interface UpdateTaskInput {
  status?: TaskStatus
  priority?: Priority
  assigned_to?: string | null
  claimed_by?: string | null
  claimed_at?: string | null
  milestone_id?: string | null
  description?: string
  completed_at?: string | null
}

export interface CreateCommentInput {
  task_id: string
  author: string
  body: string
  comment_type?: 'comment' | 'status_change' | 'claim' | 'review'
}
```

**Step 2: Commit**

```bash
git add lib/board/types.ts
git commit -m "feat: add board type definitions"
```

---

### Task 3: Board Library — `lib/board/index.ts`

**Files:**
- Create: `lib/board/index.ts`
- Test: `tests/board.test.ts`

**Step 1: Write failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/oracle/repos/optimal-cli && tsx --test tests/board.test.ts
```

Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// lib/board/index.ts
import { getSupabase } from '../supabase.js'
import type {
  Project, Task, Label, Comment, Milestone, ActivityEntry,
  CreateProjectInput, CreateTaskInput, CreateCommentInput, CreateMilestoneInput,
  UpdateTaskInput, TaskStatus,
} from './types.js'

export * from './types.js'

const sb = () => getSupabase('optimal')

// --- Helpers ---

export function formatBoardTable(tasks: Task[]): string {
  if (tasks.length === 0) return 'No tasks found.'
  const lines = [
    '| Status      | P | Title                          | Agent   | Skill           | Effort |',
    '|-------------|---|--------------------------------|---------|-----------------|--------|',
  ]
  const order: TaskStatus[] = ['in_progress', 'claimed', 'blocked', 'ready', 'review', 'backlog', 'done']
  const sorted = [...tasks].sort((a, b) => {
    const ai = order.indexOf(a.status)
    const bi = order.indexOf(b.status)
    if (ai !== bi) return ai - bi
    return a.priority - b.priority
  })
  for (const t of sorted) {
    const title = t.title.length > 30 ? t.title.slice(0, 27) + '...' : t.title.padEnd(30)
    const agent = (t.claimed_by ?? t.assigned_to ?? '—').padEnd(7)
    const skill = (t.skill_required ?? '—').padEnd(15)
    const effort = (t.estimated_effort ?? '—').padEnd(6)
    lines.push(`| ${t.status.padEnd(11)} | ${t.priority} | ${title} | ${agent} | ${skill} | ${effort} |`)
  }
  lines.push(`\nTotal: ${tasks.length} tasks`)
  return lines.join('\n')
}

export function getNextClaimable(readyTasks: Task[], allTasks: Task[]): Task | null {
  for (const task of readyTasks) {
    if (!task.blocked_by || task.blocked_by.length === 0) return task
    const allDone = task.blocked_by.every(depId => {
      const dep = allTasks.find(t => t.id === depId)
      return dep && (dep.status === 'done')
    })
    if (allDone) return task
  }
  return null
}

// --- Projects ---

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      owner: input.owner ?? null,
      priority: input.priority ?? 3,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create project: ${error.message}`)
  return data as Project
}

export async function getProjectBySlug(slug: string): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single()
  if (error) throw new Error(`Project not found: ${slug} — ${error.message}`)
  return data as Project
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .neq('status', 'archived')
    .order('priority', { ascending: true })
  if (error) throw new Error(`Failed to list projects: ${error.message}`)
  return (data ?? []) as Project[]
}

export async function updateProject(slug: string, updates: Partial<Pick<Project, 'status' | 'owner' | 'priority' | 'description'>>): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .update(updates)
    .eq('slug', slug)
    .select()
    .single()
  if (error) throw new Error(`Failed to update project: ${error.message}`)
  return data as Project
}

// --- Milestones ---

export async function createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
  const { data, error } = await sb()
    .from('milestones')
    .insert({
      project_id: input.project_id,
      name: input.name,
      description: input.description ?? null,
      due_date: input.due_date ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create milestone: ${error.message}`)
  return data as Milestone
}

export async function listMilestones(projectId?: string): Promise<Milestone[]> {
  let query = sb().from('milestones').select('*').order('due_date', { ascending: true })
  if (projectId) query = query.eq('project_id', projectId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list milestones: ${error.message}`)
  return (data ?? []) as Milestone[]
}

// --- Labels ---

export async function createLabel(name: string, color?: string): Promise<Label> {
  const { data, error } = await sb()
    .from('labels')
    .insert({ name, color: color ?? null })
    .select()
    .single()
  if (error) throw new Error(`Failed to create label: ${error.message}`)
  return data as Label
}

export async function listLabels(): Promise<Label[]> {
  const { data, error } = await sb().from('labels').select('*').order('name')
  if (error) throw new Error(`Failed to list labels: ${error.message}`)
  return (data ?? []) as Label[]
}

export async function getLabelByName(name: string): Promise<Label | null> {
  const { data } = await sb().from('labels').select('*').eq('name', name).single()
  return (data as Label) ?? null
}

// --- Tasks ---

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const { labels: labelNames, ...rest } = input
  const { data, error } = await sb()
    .from('tasks')
    .insert({
      ...rest,
      milestone_id: rest.milestone_id ?? null,
      description: rest.description ?? null,
      priority: rest.priority ?? 3,
      skill_required: rest.skill_required ?? null,
      source_repo: rest.source_repo ?? null,
      target_module: rest.target_module ?? null,
      estimated_effort: rest.estimated_effort ?? null,
      blocked_by: rest.blocked_by ?? [],
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create task: ${error.message}`)
  const task = data as Task

  if (labelNames && labelNames.length > 0) {
    for (const name of labelNames) {
      const label = await getLabelByName(name)
      if (label) {
        await sb().from('task_labels').insert({ task_id: task.id, label_id: label.id })
      }
    }
  }

  await logActivity({ task_id: task.id, project_id: task.project_id, actor: 'system', action: 'created', new_value: { title: task.title } })
  return task
}

export async function updateTask(taskId: string, updates: UpdateTaskInput, actor?: string): Promise<Task> {
  const old = await getTask(taskId)
  const { data, error } = await sb()
    .from('tasks')
    .update(updates)
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(`Failed to update task ${taskId}: ${error.message}`)
  const task = data as Task

  if (actor) {
    await logActivity({
      task_id: taskId,
      project_id: task.project_id,
      actor,
      action: updates.status ? 'status_changed' : 'updated',
      old_value: { status: old.status, assigned_to: old.assigned_to },
      new_value: updates as Record<string, unknown>,
    })
  }
  return task
}

export async function getTask(taskId: string): Promise<Task> {
  const { data, error } = await sb()
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .single()
  if (error) throw new Error(`Task not found: ${taskId}`)
  return data as Task
}

export async function listTasks(opts?: {
  project_id?: string
  status?: TaskStatus
  claimed_by?: string
  assigned_to?: string
}): Promise<Task[]> {
  let query = sb().from('tasks').select('*')
  if (opts?.project_id) query = query.eq('project_id', opts.project_id)
  if (opts?.status) query = query.eq('status', opts.status)
  if (opts?.claimed_by) query = query.eq('claimed_by', opts.claimed_by)
  if (opts?.assigned_to) query = query.eq('assigned_to', opts.assigned_to)
  query = query.order('priority', { ascending: true }).order('sort_order', { ascending: true })
  const { data, error } = await query
  if (error) throw new Error(`Failed to list tasks: ${error.message}`)
  return (data ?? []) as Task[]
}

export async function claimTask(taskId: string, agent: string): Promise<Task> {
  const task = await updateTask(taskId, {
    status: 'claimed',
    claimed_by: agent,
    claimed_at: new Date().toISOString(),
  }, agent)

  await addComment({ task_id: taskId, author: agent, body: `Claimed by ${agent}`, comment_type: 'claim' })
  return task
}

export async function completeTask(taskId: string, actor: string): Promise<Task> {
  return updateTask(taskId, {
    status: 'done',
    completed_at: new Date().toISOString(),
  }, actor)
}

// --- Comments ---

export async function addComment(input: CreateCommentInput): Promise<Comment> {
  const { data, error } = await sb()
    .from('comments')
    .insert({
      task_id: input.task_id,
      author: input.author,
      body: input.body,
      comment_type: input.comment_type ?? 'comment',
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to add comment: ${error.message}`)
  return data as Comment
}

export async function listComments(taskId: string): Promise<Comment[]> {
  const { data, error } = await sb()
    .from('comments')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to list comments: ${error.message}`)
  return (data ?? []) as Comment[]
}

// --- Activity Log ---

export async function logActivity(entry: {
  task_id?: string
  project_id?: string
  actor: string
  action: string
  old_value?: Record<string, unknown>
  new_value?: Record<string, unknown>
}): Promise<void> {
  const { error } = await sb()
    .from('activity_log')
    .insert({
      task_id: entry.task_id ?? null,
      project_id: entry.project_id ?? null,
      actor: entry.actor,
      action: entry.action,
      old_value: entry.old_value ?? null,
      new_value: entry.new_value ?? null,
    })
  if (error) throw new Error(`Failed to log activity: ${error.message}`)
}

export async function listActivity(opts?: { task_id?: string; actor?: string; limit?: number }): Promise<ActivityEntry[]> {
  let query = sb().from('activity_log').select('*')
  if (opts?.task_id) query = query.eq('task_id', opts.task_id)
  if (opts?.actor) query = query.eq('actor', opts.actor)
  query = query.order('created_at', { ascending: false }).limit(opts?.limit ?? 50)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list activity: ${error.message}`)
  return (data ?? []) as ActivityEntry[]
}
```

**Step 4: Run tests**

```bash
cd /home/oracle/repos/optimal-cli && tsx --test tests/board.test.ts
```

Expected: All 5 tests pass (module loads, formatBoardTable works, getNextClaimable filters correctly)

**Step 5: Commit**

```bash
git add lib/board/index.ts lib/board/types.ts tests/board.test.ts
git commit -m "feat: add board library with types, CRUD, claim, comment, activity log"
```

---

### Task 4: CLI Commands — Rewrite `bin/optimal.ts` board section

**Files:**
- Modify: `bin/optimal.ts` — replace old board imports and commands

**Step 1: Replace old kanban import with new board import**

Remove:
```typescript
import { getBoard, createTask, updateTask, logActivity, type CliTask } from '../lib/kanban.js'
```

Add:
```typescript
import {
  createProject, getProjectBySlug, listProjects, updateProject,
  createMilestone, listMilestones,
  createLabel, listLabels,
  createTask, updateTask, getTask, listTasks, claimTask, completeTask,
  addComment, listComments,
  logActivity, listActivity,
  formatBoardTable, getNextClaimable,
  type Task, type TaskStatus,
} from '../lib/board/index.js'
```

**Step 2: Replace the `board` command group**

Replace the entire board command section with:

```typescript
// --- Board commands ---
const board = program.command('board').description('Kanban board operations')

board
  .command('view')
  .description('Display the kanban board')
  .option('-p, --project <slug>', 'Project slug')
  .option('-s, --status <status>', 'Filter by status')
  .option('--mine <agent>', 'Show only tasks claimed by agent')
  .action(async (opts) => {
    const filters: { project_id?: string; status?: TaskStatus; claimed_by?: string } = {}
    if (opts.project) {
      const proj = await getProjectBySlug(opts.project)
      filters.project_id = proj.id
    }
    if (opts.status) filters.status = opts.status as TaskStatus
    if (opts.mine) filters.claimed_by = opts.mine
    const tasks = await listTasks(filters)
    console.log(formatBoardTable(tasks))
  })

board
  .command('create')
  .description('Create a new task')
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-p, --project <slug>', 'Project slug')
  .option('-d, --description <desc>', 'Task description')
  .option('--priority <n>', 'Priority 1-4', '3')
  .option('--skill <ref>', 'Skill reference')
  .option('--source <repo>', 'Source repo')
  .option('--target <module>', 'Target module')
  .option('--effort <size>', 'Effort: xs, s, m, l, xl')
  .option('--blocked-by <ids>', 'Comma-separated blocking task IDs')
  .option('--labels <labels>', 'Comma-separated labels')
  .action(async (opts) => {
    const project = await getProjectBySlug(opts.project)
    const task = await createTask({
      project_id: project.id,
      title: opts.title,
      description: opts.description,
      priority: parseInt(opts.priority) as 1 | 2 | 3 | 4,
      skill_required: opts.skill,
      source_repo: opts.source,
      target_module: opts.target,
      estimated_effort: opts.effort,
      blocked_by: opts.blockedBy?.split(',') ?? [],
      labels: opts.labels?.split(',') ?? [],
    })
    console.log(`Created task: ${task.id}\n  ${task.title} [${task.status}] P${task.priority}`)
  })

board
  .command('update')
  .description('Update a task')
  .requiredOption('--id <uuid>', 'Task ID')
  .option('-s, --status <status>', 'New status')
  .option('-a, --agent <name>', 'Assign to agent')
  .option('--priority <n>', 'New priority')
  .option('-m, --message <msg>', 'Log message (adds comment)')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.agent) updates.assigned_to = opts.agent
    if (opts.priority) updates.priority = parseInt(opts.priority)
    if (opts.status === 'done') updates.completed_at = new Date().toISOString()
    const task = await updateTask(opts.id, updates, opts.agent ?? 'cli')
    if (opts.message) await addComment({ task_id: task.id, author: opts.agent ?? 'cli', body: opts.message })
    console.log(`Updated: ${task.title} -> ${task.status}`)
  })

board
  .command('claim')
  .description('Claim a task (bot pull model)')
  .requiredOption('--id <uuid>', 'Task ID')
  .requiredOption('--agent <name>', 'Agent name')
  .action(async (opts) => {
    const task = await claimTask(opts.id, opts.agent)
    console.log(`Claimed: ${task.title} by ${opts.agent}`)
  })

board
  .command('comment')
  .description('Add a comment to a task')
  .requiredOption('--id <uuid>', 'Task ID')
  .requiredOption('--author <name>', 'Author name')
  .requiredOption('--body <text>', 'Comment body')
  .action(async (opts) => {
    const comment = await addComment({ task_id: opts.id, author: opts.author, body: opts.body })
    console.log(`Comment added by ${comment.author} at ${comment.created_at}`)
  })

board
  .command('log')
  .description('View activity log')
  .option('--task <uuid>', 'Filter by task ID')
  .option('--actor <name>', 'Filter by actor')
  .option('--limit <n>', 'Max entries', '20')
  .action(async (opts) => {
    const entries = await listActivity({
      task_id: opts.task,
      actor: opts.actor,
      limit: parseInt(opts.limit),
    })
    for (const e of entries) {
      console.log(`${e.created_at} | ${e.actor.padEnd(8)} | ${e.action.padEnd(15)} | ${JSON.stringify(e.new_value ?? {})}`)
    }
    console.log(`\n${entries.length} entries`)
  })

// --- Project commands ---
const proj = program.command('project').description('Project management')

proj
  .command('list')
  .description('List all projects')
  .action(async () => {
    const projects = await listProjects()
    console.log('| Status   | P | Slug                    | Owner   | Name |')
    console.log('|----------|---|-------------------------|---------|------|')
    for (const p of projects) {
      console.log(`| ${p.status.padEnd(8)} | ${p.priority} | ${p.slug.padEnd(23)} | ${(p.owner ?? '—').padEnd(7)} | ${p.name} |`)
    }
  })

proj
  .command('create')
  .description('Create a project')
  .requiredOption('--slug <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Project name')
  .option('--owner <name>', 'Owner')
  .option('--priority <n>', 'Priority 1-4', '3')
  .action(async (opts) => {
    const p = await createProject({
      slug: opts.slug,
      name: opts.name,
      owner: opts.owner,
      priority: parseInt(opts.priority) as 1 | 2 | 3 | 4,
    })
    console.log(`Created project: ${p.slug} (${p.id})`)
  })

proj
  .command('update')
  .description('Update a project')
  .requiredOption('--slug <slug>', 'Project slug')
  .option('-s, --status <status>', 'New status')
  .option('--owner <name>', 'New owner')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.owner) updates.owner = opts.owner
    const p = await updateProject(opts.slug, updates)
    console.log(`Updated project: ${p.slug} -> ${p.status}`)
  })

// --- Milestone commands ---
const ms = program.command('milestone').description('Milestone management')

ms
  .command('create')
  .description('Create a milestone')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Milestone name')
  .option('--due <date>', 'Due date (YYYY-MM-DD)')
  .action(async (opts) => {
    const project = await getProjectBySlug(opts.project)
    const m = await createMilestone({ project_id: project.id, name: opts.name, due_date: opts.due })
    console.log(`Created milestone: ${m.name} (${m.id})`)
  })

ms
  .command('list')
  .description('List milestones')
  .option('--project <slug>', 'Filter by project')
  .action(async (opts) => {
    let projectId: string | undefined
    if (opts.project) {
      const p = await getProjectBySlug(opts.project)
      projectId = p.id
    }
    const milestones = await listMilestones(projectId)
    for (const m of milestones) {
      console.log(`${m.status.padEnd(10)} | ${m.due_date ?? 'no date'} | ${m.name}`)
    }
  })

// --- Label commands ---
const lbl = program.command('label').description('Label management')

lbl
  .command('create')
  .description('Create a label')
  .requiredOption('--name <name>', 'Label name')
  .option('--color <hex>', 'Color hex code')
  .action(async (opts) => {
    const l = await createLabel(opts.name, opts.color)
    console.log(`Created label: ${l.name} (${l.id})`)
  })

lbl
  .command('list')
  .description('List all labels')
  .action(async () => {
    const labels = await listLabels()
    for (const l of labels) console.log(`${l.name}${l.color ? ` (${l.color})` : ''}`)
  })
```

**Step 3: Update any other files that import from `lib/kanban.ts`**

Search for all imports of `lib/kanban` and replace with `lib/board/index`. The old `lib/kanban.ts` references in skills should also be updated. Specifically, update `logSkillExecution` calls throughout — this function now lives in `lib/board/index.ts`.

**Step 4: Commit**

```bash
git add bin/optimal.ts
git commit -m "feat: rewrite CLI board/project/milestone/label commands for new schema"
```

---

### Task 5: Seed Script — Projects, Labels, and 33 Migration Tasks

**Files:**
- Create: `scripts/seed-board.ts`

**Step 1: Write the seed script**

The script creates 5 projects, 6 labels, and 33 tasks from the feature inventory. Run with `tsx scripts/seed-board.ts`.

See `docs/plans/2026-03-05-kanban-rebuild-design.md` for the full task list (features #30-62). The seed script should:

1. Create projects:
   - `website-to-cli` (priority 2)
   - `satellite-to-cli` (priority 2)
   - `bot-orchestration` (priority 1)
   - `returnpro-mcp-prep` (priority 1)
   - `cli-polish` (priority 3)

2. Create labels:
   - `migration` (#3B82F6)
   - `new-feature` (#10B981)
   - `infra` (#8B5CF6)
   - `high-complexity` (#EF4444)
   - `bot-task` (#F59E0B)
   - `career-critical` (#EC4899)

3. Create 33 tasks with correct project assignment, priority, source_repo, target_module, estimated_effort, skill_required, and labels.

The tasks map directly from features #30-62 in the inventory. Each task title should be action-oriented (e.g., "Migrate auth system from optimalOS to CLI", "Port Wes budget projections to CLI").

**Step 2: Run seed**

```bash
cd /home/oracle/repos/optimal-cli && tsx scripts/seed-board.ts
```

Expected: All projects, labels, and tasks created. Board populated.

**Step 3: Verify with CLI**

```bash
tsx bin/optimal.ts project list
tsx bin/optimal.ts board view --project website-to-cli
tsx bin/optimal.ts board view --project satellite-to-cli
tsx bin/optimal.ts board view --project bot-orchestration
tsx bin/optimal.ts board view --project returnpro-mcp-prep
```

**Step 4: Commit**

```bash
git add scripts/seed-board.ts
git commit -m "feat: add seed script with 5 projects, 6 labels, 33 migration tasks"
```

---

### Task 6: Delete old `lib/kanban.ts`

**Files:**
- Delete: `lib/kanban.ts`
- Modify: any remaining imports pointing to `lib/kanban`

**Step 1: Find and fix remaining imports**

```bash
grep -r "kanban" lib/ bin/ skills/ --include="*.ts" --include="*.md" -l
```

Replace all `lib/kanban` imports with `lib/board/index`. Update `logSkillExecution` references.

**Step 2: Delete old file**

```bash
rm lib/kanban.ts
```

**Step 3: Run full test suite**

```bash
tsx --test tests/*.test.ts
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old lib/kanban.ts, migrate all imports to lib/board"
```

---

### Task 7: Integration Test — Full Board Workflow

**Files:**
- Create: `tests/board-integration.test.ts`

**Step 1: Write integration test**

This test runs against live Supabase (requires env vars). Tests the full lifecycle: create project → create task → claim → update → complete → verify activity log.

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProject, listProjects, getProjectBySlug,
  createTask, listTasks, claimTask, updateTask, completeTask, getTask,
  createLabel, listLabels,
  addComment, listComments,
  listActivity,
  formatBoardTable,
} from '../lib/board/index.ts'

const TEST_SLUG = `test-${Date.now()}`

test('full board lifecycle', async () => {
  // Create project
  const project = await createProject({ slug: TEST_SLUG, name: 'Integration Test', priority: 4 })
  assert.ok(project.id)
  assert.equal(project.slug, TEST_SLUG)

  // List projects
  const projects = await listProjects()
  assert.ok(projects.some(p => p.slug === TEST_SLUG))

  // Create label
  const label = await createLabel(`test-label-${Date.now()}`)
  assert.ok(label.id)

  // Create task
  const task = await createTask({
    project_id: project.id,
    title: 'Integration test task',
    priority: 2,
    estimated_effort: 's',
    labels: [label.name],
  })
  assert.ok(task.id)
  assert.equal(task.status, 'backlog')

  // List tasks
  const tasks = await listTasks({ project_id: project.id })
  assert.ok(tasks.length >= 1)

  // Format board
  const table = formatBoardTable(tasks)
  assert.ok(table.includes('Integration test task'))

  // Update to ready
  await updateTask(task.id, { status: 'ready' }, 'test')

  // Claim
  const claimed = await claimTask(task.id, 'test-bot')
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.claimed_by, 'test-bot')

  // Comment
  await addComment({ task_id: task.id, author: 'test-bot', body: 'Working on it' })
  const comments = await listComments(task.id)
  assert.ok(comments.length >= 1)

  // Complete
  const done = await completeTask(task.id, 'test-bot')
  assert.equal(done.status, 'done')
  assert.ok(done.completed_at)

  // Activity log
  const activity = await listActivity({ task_id: task.id })
  assert.ok(activity.length >= 3) // created + status_changed + claimed + completed

  console.log(`Integration test passed. Project: ${TEST_SLUG}`)
})
```

**Step 2: Run**

```bash
cd /home/oracle/repos/optimal-cli && tsx --test tests/board-integration.test.ts
```

**Step 3: Commit**

```bash
git add tests/board-integration.test.ts
git commit -m "test: add board integration test covering full lifecycle"
```

---

## Execution Order

1. Task 1: Migration SQL (schema)
2. Task 2: Types
3. Task 3: Board library + unit tests
4. Task 4: CLI commands
5. Task 5: Seed script (populate 33 tasks)
6. Task 6: Delete old kanban.ts
7. Task 7: Integration test

Total estimated effort: ~45 minutes of implementation.
