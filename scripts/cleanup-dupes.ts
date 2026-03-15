import { getSupabase } from '../lib/supabase.js'

const sb = getSupabase('optimal')

// Get all tasks
const { data: tasks } = await sb.from('tasks').select('id, title, status')
if (!tasks) { console.error('No tasks found'); process.exit(1) }

// Find done titles
const doneTitles = new Set(tasks.filter(t => t.status === 'done').map(t => t.title))

// Find backlog duplicates
const dupes = tasks.filter(t => t.status === 'backlog' && doneTitles.has(t.title))
console.log(`Deleting ${dupes.length} duplicate backlog tasks...`)

const ids = dupes.map(t => t.id)
if (ids.length > 0) {
  const { error } = await sb.from('tasks').delete().in('id', ids)
  if (error) {
    console.error('Error:', error)
  } else {
    console.log(`Deleted ${ids.length} duplicates`)
  }
}

// Verify
const { data: remaining } = await sb.from('tasks').select('id, title, status').eq('status', 'backlog')
console.log(`Remaining backlog tasks: ${remaining?.length ?? 0}`)
