/**
 * optimal-hub — OpenClaw plugin exposing the OptimalOS kanban board
 * (and ReturnPro Supabase board) to agents via 5 tools:
 *   - board_view, board_create, board_claim, board_update, board_complete
 *
 * Loaded by OpenClaw via the manifest in openclaw.plugin.json. The
 * `definePluginEntry` helper from `openclaw/plugin-sdk/core` is the canonical
 * way to expose a non-channel plugin; we import it dynamically so this module
 * also loads in environments where the host openclaw package isn't on the
 * resolver path (CI smoke tests, the optimal-cli monorepo).
 */

import { BoardOps } from './lib/board-ops.js'
import { SupabaseClients } from './lib/supabase-clients.js'
import type { PluginConfig } from './lib/types.js'
import { createBoardClaimTool } from './tools/board-claim.js'
import { createBoardCompleteTool } from './tools/board-complete.js'
import { createBoardCreateTool } from './tools/board-create.js'
import { createBoardUpdateTool } from './tools/board-update.js'
import { createBoardViewTool } from './tools/board-view.js'

export type { PluginConfig } from './lib/types.js'
export { BoardOps } from './lib/board-ops.js'
export { SupabaseClients } from './lib/supabase-clients.js'
export { createBoardClaimTool } from './tools/board-claim.js'
export { createBoardCompleteTool } from './tools/board-complete.js'
export { createBoardCreateTool } from './tools/board-create.js'
export { createBoardUpdateTool } from './tools/board-update.js'
export { createBoardViewTool } from './tools/board-view.js'

const PLUGIN_ID = 'optimal-hub'
const PLUGIN_NAME = 'Optimal Hub'
const PLUGIN_DESCRIPTION =
  'OptimalOS kanban + ReturnPro Supabase board access for OpenClaw agents.'

/**
 * Build the 5 board tools for a given plugin config. Exported so callers
 * (CLI smoke tests, OptimalOS dev console) can register the same tool set
 * outside the plugin loader.
 */
export function buildBoardTools(config: PluginConfig) {
  const clients = new SupabaseClients(config)
  const board = new BoardOps(clients, config.defaultActor ?? 'optimal-hub')
  return {
    clients,
    board,
    tools: [
      createBoardViewTool(board),
      createBoardCreateTool(board),
      createBoardClaimTool(board),
      createBoardUpdateTool(board),
      createBoardCompleteTool(board),
    ],
  }
}

type RegisterApi = {
  pluginConfig?: PluginConfig
  registerTool: (tool: unknown) => void
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

/**
 * The shape OpenClaw expects from a plugin entry module: an object with
 * `id`, `name`, `description`, and a `register(api)` function that the loader
 * calls during gateway startup. We optionally route through `definePluginEntry`
 * for canonical typing when openclaw's plugin-sdk is on the module resolver.
 */
function buildEntry() {
  const entry = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    register(api: RegisterApi) {
      const config = api.pluginConfig as PluginConfig | undefined
      if (!config?.optimalSupabaseUrl || !config?.optimalSupabaseServiceKey) {
        api.logger.error(
          'optimal-hub: missing required config — set optimalSupabaseUrl and optimalSupabaseServiceKey ' +
            'in plugins.entries.optimal-hub.config (see openclaw.plugin.json).',
        )
        return
      }

      const { tools } = buildBoardTools(config)
      for (const tool of tools) api.registerTool(tool)

      const returnproStatus =
        config.returnproSupabaseUrl && config.returnproSupabaseServiceKey
          ? 'ReturnPro Supabase configured'
          : 'ReturnPro Supabase NOT configured (returnpro tools will throw on use)'

      api.logger.info(
        `optimal-hub: registered ${tools.length} board tools against ${config.optimalSupabaseUrl}. ${returnproStatus}.`,
      )
    },
  }
  return entry
}

const entry = buildEntry()

// `definePluginEntry` is the canonical wrapper; if it's importable we run the
// entry through it so the loader picks up `kind`, `reload`, schema defaults,
// etc. We import lazily to avoid a hard dependency on `openclaw` at install
// time — a standalone smoke test only needs the default export shape.
async function tryWrapWithDefinePluginEntry(): Promise<unknown> {
  try {
    // Indirect string keeps TypeScript from trying to resolve the openclaw
    // SDK at compile time — it's only required at runtime when the plugin
    // is loaded by an actual gateway.
    const sdkSpecifier = 'openclaw/plugin-sdk/core'
    const mod = (await import(/* @vite-ignore */ sdkSpecifier)) as {
      definePluginEntry?: (opts: unknown) => unknown
    }
    if (typeof mod.definePluginEntry === 'function') {
      return mod.definePluginEntry({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        register: entry.register,
      })
    }
  } catch {
    // openclaw package not on resolver — fall back to the plain entry shape
    // (still valid: OpenClaw accepts any object with id/name/description/register).
  }
  return entry
}

// Top-level await is fine in ESM and OpenClaw's loader awaits the module.
const definedEntry = await tryWrapWithDefinePluginEntry()

export default definedEntry
