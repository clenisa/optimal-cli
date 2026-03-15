import { getSupabase } from '../lib/supabase.js'

const sb = getSupabase('optimal')

// Get mappings
const { data: mappings } = await sb.from('discord_mappings').select('*')
const { data: projects } = await sb.from('projects').select('id, slug')

const projectNames = Object.fromEntries((projects ?? []).map(p => [p.id, p.slug]))

console.log('Discord Mappings:')
for (const m of mappings ?? []) {
  const proj = projectNames[m.project_id] ?? 'unknown'
  const type = m.entity_type ?? 'null'
  const thread = m.discord_thread_id ? `thread:${m.discord_thread_id}` : ''
  console.log(`  ${type.padEnd(8)} | ${proj.padEnd(20)} | channel:${m.discord_channel_id} ${thread}`)
}

// Check which projects have channel mappings
const mappedProjects = new Set((mappings ?? []).filter(m => m.entity_type === 'project').map(m => m.project_id))
console.log('\nProjects with channel mappings:')
for (const p of projects ?? []) {
  const mapped = mappedProjects.has(p.id) ? '✅' : '❌'
  console.log(`  ${mapped} ${p.slug} (${p.id})`)
}
