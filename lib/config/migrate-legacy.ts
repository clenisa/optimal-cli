import { getSupabase } from '../supabase.js';

interface LegacyConfig {
  agent_name: string;
  config_json: Record<string, unknown>;
  updated_at: string;
}

export async function migrateLegacyConfig(agentName: string): Promise<void> {
  const supabase = getSupabase('optimal');

  // Read from legacy table
  const { data: legacy, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('agent_name', agentName)
    .single();

  if (error || !legacy) {
    console.log(`No legacy config for ${agentName}, skipping`);
    return;
  }

  const typed = legacy as LegacyConfig;

  // Build registry v1 payload
  const payload = {
    profile: {
      name: agentName,
      owner: (typed.config_json as any)?.owner || 'unknown',
      config_version: typed.updated_at,
      skills: (typed.config_json as any)?.skills || ['*'],
      metadata: typed.config_json,
    },
  };

  const payloadStr = JSON.stringify(payload);
  const { createHash } = await import('crypto');
  const payloadHash = createHash('sha256').update(payloadStr).digest('hex');

  // Upsert to registry v1
  const { error: upsertError } = await supabase
    .from('cli_config_registry')
    .upsert({
      owner: agentName,
      profile: 'default',
      payload,
      payload_hash: payloadHash,
      source: 'migration',
      updated_by: 'migrate-legacy',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'owner,profile' });

  if (upsertError) {
    throw new Error(`Migration failed for ${agentName}: ${upsertError.message}`);
  }

  console.log(`Migrated ${agentName} config to registry v1`);
}

export async function migrateAllLegacyConfigs(): Promise<void> {
  const supabase = getSupabase('optimal');
  const { data: configs } = await supabase.from('agent_configs').select('agent_name');
  if (!configs || configs.length === 0) {
    console.log('No legacy configs to migrate');
    return;
  }
  for (const config of configs) {
    await migrateLegacyConfig(config.agent_name);
  }
  console.log(`Migrated ${configs.length} configs to registry v1`);
}
