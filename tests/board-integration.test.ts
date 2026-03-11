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

// Skip integration tests when supabase credentials aren't available
const hasSupabaseCreds = !!(process.env.OPTIMAL_SUPABASE_URL && process.env.OPTIMAL_SUPABASE_SERVICE_KEY)

test('full board lifecycle', { skip: !hasSupabaseCreds }, async () => {
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
