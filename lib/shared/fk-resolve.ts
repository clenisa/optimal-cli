import { getSupabase } from '../supabase.js';
import { paginateAll } from './paginate.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FKContext {
  /** account_code → account_id */
  accountMap: Map<string, number>;
  /** account_code → sign_multiplier (default 1) */
  signMultiplierMap: Map<string, number>;
  /** client_name → client_id */
  clientMap: Map<string, number>;
  /** "${clientId}|${masterProgramName}" → master_program_id */
  masterProgramIdMap: Map<string, number>;
  /** program_code → program_id_key */
  programIdMap: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Individual resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve account_code → { account_id, sign_multiplier } from dim_account.
 */
export async function resolveAccount(
  codes: string[],
): Promise<{ accountMap: Map<string, number>; signMultiplierMap: Map<string, number> }> {
  const sb = getSupabase('returnpro');
  const unique = Array.from(new Set(codes.filter(Boolean)));
  const accountMap = new Map<string, number>();
  const signMultiplierMap = new Map<string, number>();

  for (const batch of chunkArray(unique, 100)) {
    const { data, error } = await sb
      .from('dim_account')
      .select('account_id,account_code,sign_multiplier')
      .in('account_code', batch);

    if (error) continue;
    for (const row of (data ?? []) as Array<{
      account_id: number;
      account_code: string;
      sign_multiplier: number | null;
    }>) {
      accountMap.set(row.account_code, row.account_id);
      signMultiplierMap.set(row.account_code, row.sign_multiplier ?? 1);
    }
  }

  return { accountMap, signMultiplierMap };
}

/**
 * Resolve program_code → program_id_key from dim_program_id.
 */
export async function resolveProgram(
  codes: string[],
): Promise<Map<string, number>> {
  const sb = getSupabase('returnpro');
  const unique = Array.from(new Set(codes.filter(Boolean)));
  const map = new Map<string, number>();

  for (const batch of chunkArray(unique, 100)) {
    const { data, error } = await sb
      .from('dim_program_id')
      .select('program_id_key,program_code')
      .in('program_code', batch);

    if (error) continue;
    for (const row of (data ?? []) as Array<{
      program_id_key: number;
      program_code: string;
    }>) {
      map.set(row.program_code, row.program_id_key);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Full context loader
// ---------------------------------------------------------------------------

/**
 * Load the full FK resolution context needed to stamp staging rows.
 *
 * Fetches all dimension maps in parallel where possible:
 *   - account_code → dim_account (account_id, sign_multiplier)
 *   - client_name → dim_client (client_id)
 *   - program_code → dim_program_id (program_id_key)
 *   - master_program → dim_master_program (master_program_id, requires client_id)
 *
 * Master program lookup uses composite key: `${clientId}|${masterProgramName}`
 *
 * @param accountCodes  Array of account codes to resolve
 * @param locations     Array of client names (locations) to resolve
 * @param programCodes  Array of program codes to resolve
 * @param masterProgramInputs  Array of { master_program, location } pairs for
 *                             master program resolution (location must match clientMap keys)
 */
export async function loadFKContext(
  accountCodes: string[],
  locations: string[],
  programCodes: string[],
  masterProgramInputs: Array<{ master_program: string; location: string }>,
): Promise<FKContext> {
  const sb = getSupabase('returnpro');

  // Phase 1: Resolve accounts, clients, and programs in parallel
  const uniqueLocations = Array.from(new Set(locations.filter(Boolean)));
  const clientMap = new Map<string, number>();

  const [accountResult, programIdMap] = await Promise.all([
    resolveAccount(accountCodes),
    resolveProgram(programCodes),
    // Client resolution inline (parallel with the others)
    (async () => {
      for (const batch of chunkArray(uniqueLocations, 100)) {
        const { data, error } = await sb
          .from('dim_client')
          .select('client_id,client_name')
          .in('client_name', batch);

        if (error) continue;
        for (const row of (data ?? []) as Array<{
          client_id: number;
          client_name: string;
        }>) {
          clientMap.set(row.client_name, row.client_id);
        }
      }
    })(),
  ]);

  const { accountMap, signMultiplierMap } = accountResult;

  // Phase 2: Master program resolution (depends on clientMap)
  const masterProgramIdMap = new Map<string, number>();

  // Group by client_id for batched queries
  const byClient = new Map<number, string[]>();
  for (const input of masterProgramInputs) {
    const clientId = clientMap.get(input.location);
    if (!clientId || !input.master_program) continue;
    if (!byClient.has(clientId)) byClient.set(clientId, []);
    byClient.get(clientId)!.push(input.master_program);
  }

  for (const [clientId, names] of byClient.entries()) {
    for (const batch of chunkArray(Array.from(new Set(names)), 100)) {
      const { data, error } = await sb
        .from('dim_master_program')
        .select('master_program_id,master_name,client_id')
        .in('master_name', batch)
        .eq('client_id', clientId);

      if (error) continue;
      for (const row of (data ?? []) as Array<{
        master_program_id: number;
        master_name: string;
        client_id: number;
      }>) {
        masterProgramIdMap.set(`${row.client_id}|${row.master_name}`, row.master_program_id);
      }
    }
  }

  return {
    accountMap,
    signMultiplierMap,
    clientMap,
    masterProgramIdMap,
    programIdMap,
  };
}
