import { getSupabase } from '../lib/supabase.js'

const sb = getSupabase('optimal')

// Find test projects
const { data: projects } = await sb.from('projects').select('id, slug')
if (!projects) { console.error('No projects'); process.exit(1) }

const testProjects = projects.filter(p => p.slug.startsWith('test-'))
console.log(`Found ${testProjects.length} test projects to clean up`)

if (testProjects.length === 0) process.exit(0)

const ids = testProjects.map(p => p.id)

// Delete tasks associated with test projects first
const { error: taskErr } = await sb.from('tasks').delete().in('project_id', ids)
if (taskErr) console.error('Error deleting test tasks:', taskErr.message)

// Delete discord mappings
const { error: mapErr } = await sb.from('discord_mappings').delete().in('project_id', ids)
if (mapErr) console.error('Error deleting test mappings:', mapErr.message)

// Delete test projects
const { error: projErr } = await sb.from('projects').delete().in('id', ids)
if (projErr) {
  console.error('Error deleting test projects:', projErr.message)
} else {
  console.log(`Deleted ${testProjects.length} test projects`)
}

// Verify
const { data: remaining } = await sb.from('projects').select('slug')
console.log(`Remaining projects: ${remaining?.map(p => p.slug).join(', ')}`)
