import { getSupabase } from '../lib/supabase.js'
import { getMappingByProject } from '../lib/discord/channels.js'

const sb = getSupabase('optimal')

const { data: projects } = await sb.from('projects').select('id, slug')
if (!projects) { console.error('No projects'); process.exit(1) }

for (const p of projects) {
  // Raw query to see what's there
  const { data: rows, error } = await sb
    .from('discord_mappings')
    .select('*')
    .eq('project_id', p.id)
    .is('task_id', null)

  console.log(`\n${p.slug} (${p.id}):`)
  console.log(`  Raw rows where task_id IS NULL: ${rows?.length ?? 0}`)
  if (rows && rows.length > 0) {
    for (const r of rows) {
      console.log(`    id=${r.id} channel=${r.discord_channel_id} thread=${r.discord_thread_id ?? 'none'} task_id=${r.task_id}`)
    }
  }

  // Try getMappingByProject
  try {
    const mapping = await getMappingByProject(p.id)
    console.log(`  getMappingByProject: ${mapping ? '✅ found' : '❌ null'}`)
  } catch (e) {
    console.log(`  getMappingByProject: 💥 ERROR: ${(e as Error).message}`)
  }
}
