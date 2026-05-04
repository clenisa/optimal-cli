/**
 * OptimalVault — bulk .env → vault migration.
 *
 * Parses one or more dotenv files, classifies each KEY into a vault `kind`
 * (api_key | ssh_key | env_blob | oauth_refresh), dedups against existing vault
 * labels, and either prints a dry-run report or calls `addEntry` per row.
 *
 * Auth + cloud config use the same `resolveConfig` convention as `vault add`.
 * Empty/non-secret/URL keys are skipped; secrets are NEVER printed to stdout.
 */
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import {
  addEntry,
  listEntries,
  resolveConfig,
  VaultCliError,
  type VaultClientConfig,
  type VaultEntryKind,
  type VaultEntrySummary,
  type AddEntryArgs,
  type AddEntryResult,
} from "./index.js";

// ── Default source files to scan ────────────────────────────────────────

export const DEFAULT_ENV_FILES = [
  "~/.openclaw/workspace/optimal-cli/.env",
  "~/.openclaw/workspace/optimalOS/.env",
  "~/repos/dashboard-returnpro/.env.local",
  "~/strapi-cms/.env",
];

/** Common non-secret env vars that should never go into the vault. */
export const DEFAULT_SKIP_KEYS = new Set([
  "NODE_ENV",
  "PORT",
  "OPTIMALOS_DATA_DIR",
  "OPTIMAL_FABRIC_URL",
  "LOG_LEVEL",
]);

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  if (p === "~") return homedir();
  return p;
}

// ── .env parser ─────────────────────────────────────────────────────────

export interface ParsedEnvEntry {
  key: string;
  value: string;
}

/**
 * Parse a dotenv-format string. Supports:
 *   - `KEY=value` and `export KEY=value`
 *   - single-quoted values (no escapes inside)
 *   - double-quoted values (`\n`, `\t`, `\r`, `\\`, `\"` escapes)
 *   - blank lines and `#` comments
 *   - inline `# trailing comment` after unquoted values (stripped, like dotenv)
 *
 * No interpolation (`$VAR`) is performed — values are taken literally.
 */
export function parseEnv(content: string): ParsedEnvEntry[] {
  const out: ParsedEnvEntry[] = [];
  // normalize line endings; preserve newlines inside quoted values by joining via regex
  const text = content.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const stripped = raw.replace(/^\s+/, "");
    if (stripped === "" || stripped.startsWith("#")) {
      i++;
      continue;
    }
    // optional `export ` prefix
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) {
      i++;
      continue;
    }
    let keyPart = raw.slice(0, eqIdx).trim();
    if (keyPart.startsWith("export ")) keyPart = keyPart.slice("export ".length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyPart)) {
      i++;
      continue;
    }

    let rest = raw.slice(eqIdx + 1);
    let value = "";

    // Strip leading spaces inside the value region per dotenv convention
    const leading = rest.match(/^\s*/)?.[0].length ?? 0;
    rest = rest.slice(leading);

    if (rest.startsWith('"')) {
      // Double-quoted, may span multiple lines until closing unescaped "
      let buf = rest.slice(1);
      while (true) {
        let j = 0;
        let closed = false;
        let unescaped = "";
        while (j < buf.length) {
          const ch = buf[j]!;
          if (ch === "\\" && j + 1 < buf.length) {
            const nx = buf[j + 1]!;
            if (nx === "n") unescaped += "\n";
            else if (nx === "t") unescaped += "\t";
            else if (nx === "r") unescaped += "\r";
            else if (nx === "\\") unescaped += "\\";
            else if (nx === '"') unescaped += '"';
            else unescaped += nx;
            j += 2;
            continue;
          }
          if (ch === '"') {
            closed = true;
            break;
          }
          unescaped += ch;
          j++;
        }
        if (closed) {
          value = unescaped;
          break;
        }
        // need another line
        i++;
        if (i >= lines.length) {
          // unterminated — take what we have
          value = unescaped;
          break;
        }
        unescaped += "\n";
        buf = unescaped + lines[i]!;
        // restart the loop on the joined buffer
        // (simpler: recompute by setting buf and re-parsing in next iteration)
      }
      i++;
      out.push({ key: keyPart, value });
      continue;
    }

    if (rest.startsWith("'")) {
      // Single-quoted, no escapes, may span multiple lines until closing '
      let buf = rest.slice(1);
      let acc = "";
      let closed = false;
      while (true) {
        const closeIdx = buf.indexOf("'");
        if (closeIdx !== -1) {
          acc += buf.slice(0, closeIdx);
          closed = true;
          break;
        }
        acc += buf + "\n";
        i++;
        if (i >= lines.length) break;
        buf = lines[i]!;
      }
      if (!closed) {
        // unterminated — take all
      }
      value = acc;
      i++;
      out.push({ key: keyPart, value });
      continue;
    }

    // Unquoted: strip inline `#` comment, trim trailing whitespace
    const hashIdx = rest.indexOf("#");
    if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
    value = rest.trimEnd();
    i++;
    out.push({ key: keyPart, value });
  }

  return out;
}

// ── Classification ──────────────────────────────────────────────────────

/** Heuristic: pick the vault kind for a given (KEY, value) pair. */
export function classifyKind(key: string, value: string): VaultEntryKind {
  const upperKey = key.toUpperCase();
  // ssh_key: PEM blocks, SSH_*, *_PRIVATE_KEY
  if (
    /-----BEGIN /.test(value) ||
    /^SSH_/.test(upperKey) ||
    /_PRIVATE_KEY$/.test(upperKey)
  ) {
    return "ssh_key";
  }
  // oauth_refresh: literal substring match
  if (/oauth_refresh/i.test(key)) return "oauth_refresh";

  const lineCount = value.split("\n").length;
  // env_blob: multi-line content (>5 lines) with `=` chars (looks like an env file)
  if (lineCount > 5 && value.includes("=")) return "env_blob";

  // api_key: single-line and contains KEY/TOKEN/SECRET/PASSWORD AND fits the size limit
  if (
    lineCount === 1 &&
    value.length <= 512 &&
    /(KEY|TOKEN|SECRET|PASSWORD)/.test(upperKey)
  ) {
    return "api_key";
  }

  // Default fallback
  return "api_key";
}

// ── Skip rules ──────────────────────────────────────────────────────────

export interface SkipRuleOpts {
  includeUrls: boolean;
  extraSkipKeys: Set<string>;
}

export type SkipReason =
  | "empty"
  | "non-secret"
  | "url"
  | "user-skip"
  | "already-in-vault";

export function shouldSkip(
  key: string,
  value: string,
  opts: SkipRuleOpts,
): SkipReason | null {
  if (value === "") return "empty";
  if (DEFAULT_SKIP_KEYS.has(key)) return "non-secret";
  if (opts.extraSkipKeys.has(key)) return "user-skip";
  if (!opts.includeUrls && /_URL$/.test(key)) {
    // Allow webhook/secret URLs through if user explicitly opts in via --include-urls;
    // by default any *_URL is skipped.
    return "url";
  }
  return null;
}

// ── Plan + execute ──────────────────────────────────────────────────────

export interface PlanRow {
  file: string;          // basename for display
  fullPath: string;      // absolute path
  key: string;
  kind: VaultEntryKind | null;
  label: string;         // <basename>:<KEY>
  value: string;         // never printed
  action: "import" | "skip";
  skipReason?: SkipReason;
}

export interface BuildPlanInput {
  files: string[];                 // resolved absolute paths
  existingLabels: Set<string>;     // labels already in the vault (dedup)
  includeUrls: boolean;
  extraSkipKeys: Set<string>;
  /** Optional override for fs.readFileSync — used by tests. */
  readFile?: (path: string) => string;
  /** Files whose existence-check failed (warned, skipped). */
  missing?: string[];
}

export interface PlanReport {
  rows: PlanRow[];
  missingFiles: string[];
}

export function buildPlan(input: BuildPlanInput): PlanReport {
  const reader = input.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const rows: PlanRow[] = [];
  const missingFiles = [...(input.missing ?? [])];

  for (const fullPath of input.files) {
    let content: string;
    try {
      content = reader(fullPath);
    } catch {
      missingFiles.push(fullPath);
      continue;
    }
    const fileBase = basename(fullPath);
    const parsed = parseEnv(content);
    for (const { key, value } of parsed) {
      const label = `${fileBase}:${key}`;
      const skip = shouldSkip(key, value, {
        includeUrls: input.includeUrls,
        extraSkipKeys: input.extraSkipKeys,
      });
      if (skip) {
        rows.push({
          file: fileBase,
          fullPath,
          key,
          kind: null,
          label,
          value,
          action: "skip",
          skipReason: skip,
        });
        continue;
      }
      if (input.existingLabels.has(label)) {
        rows.push({
          file: fileBase,
          fullPath,
          key,
          kind: null,
          label,
          value,
          action: "skip",
          skipReason: "already-in-vault",
        });
        continue;
      }
      const kind = classifyKind(key, value);
      rows.push({
        file: fileBase,
        fullPath,
        key,
        kind,
        label,
        value,
        action: "import",
      });
    }
  }

  return { rows, missingFiles };
}

/** Format a SkipReason as a human-readable phrase for the report column. */
export function describeSkip(reason: SkipReason): string {
  switch (reason) {
    case "empty": return "SKIP (empty)";
    case "non-secret": return "SKIP (non-secret)";
    case "url": return "SKIP (URL var)";
    case "user-skip": return "SKIP (user --skip-key)";
    case "already-in-vault": return "SKIP (already in vault)";
  }
}

export interface ImportExecuteResult {
  imported: number;
  failed: Array<{ label: string; error: string }>;
}

/**
 * Execute the imports for plan rows with action === "import".
 * Calls `addEntry` for each row, building label + metadata from the row.
 * `addEntryFn` is injectable for tests; defaults to the live `addEntry`.
 */
export async function executePlan(
  cfg: VaultClientConfig,
  rows: PlanRow[],
  opts?: {
    addEntryFn?: (cfg: VaultClientConfig, args: AddEntryArgs) => Promise<AddEntryResult>;
    onProgress?: (row: PlanRow, ok: boolean, err?: string) => void;
  },
): Promise<ImportExecuteResult> {
  const fn = opts?.addEntryFn ?? addEntry;
  const importedRows = rows.filter((r) => r.action === "import" && r.kind !== null);
  const result: ImportExecuteResult = { imported: 0, failed: [] };
  const importedAt = new Date().toISOString();

  for (const row of importedRows) {
    try {
      await fn(cfg, {
        label: row.label,
        kind: row.kind!,
        value: row.value,
        metadata: {
          source_file: row.fullPath,
          imported_at: importedAt,
          env_var: row.key,
        },
      });
      result.imported++;
      opts?.onProgress?.(row, true);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      result.failed.push({ label: row.label, error: msg });
      opts?.onProgress?.(row, false, msg);
    }
  }
  return result;
}

// ── High-level orchestration (the CLI command body) ─────────────────────

export interface ImportEnvOptions {
  files?: string[];        // user-provided --file list; if empty, use defaults
  execute: boolean;
  includeUrls: boolean;
  skipKeys: string[];
  token?: string;
  cloud?: string;
}

export interface ImportEnvResultSummary {
  toImport: number;
  skipped: number;
  imported: number;
  failed: Array<{ label: string; error: string }>;
  missingFiles: string[];
  rows: PlanRow[];
  /** Distribution of `kind` across rows that would import (or did). */
  kindCounts: Record<VaultEntryKind, number>;
  /** Distribution of skip reasons. */
  skipCounts: Record<SkipReason, number>;
}

/**
 * Resolve which files to scan. If user supplied `--file`, expand `~` and use
 * those (failing fast on missing). Otherwise use DEFAULT_ENV_FILES, warning
 * (not failing) on missing files.
 */
export function resolveSourceFiles(
  userFiles: string[] | undefined,
): { files: string[]; missing: string[] } {
  if (userFiles && userFiles.length > 0) {
    const files: string[] = [];
    const missing: string[] = [];
    for (const f of userFiles) {
      const p = expandHome(f);
      if (existsSync(p)) files.push(p);
      else missing.push(p);
    }
    return { files, missing };
  }
  const files: string[] = [];
  const missing: string[] = [];
  for (const f of DEFAULT_ENV_FILES) {
    const p = expandHome(f);
    if (existsSync(p)) files.push(p);
    else missing.push(p);
  }
  return { files, missing };
}

/**
 * Tally rows for reporting. Public so tests can assert on the bucket counts
 * without re-deriving them from row arrays.
 */
export function summarize(rows: PlanRow[]): {
  toImport: number;
  skipped: number;
  kindCounts: Record<VaultEntryKind, number>;
  skipCounts: Record<SkipReason, number>;
} {
  const kindCounts: Record<VaultEntryKind, number> = {
    api_key: 0,
    oauth_refresh: 0,
    ssh_key: 0,
    env_blob: 0,
  };
  const skipCounts: Record<SkipReason, number> = {
    empty: 0,
    "non-secret": 0,
    url: 0,
    "user-skip": 0,
    "already-in-vault": 0,
  };
  let toImport = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.action === "import" && r.kind) {
      kindCounts[r.kind]++;
      toImport++;
    } else if (r.action === "skip" && r.skipReason) {
      skipCounts[r.skipReason]++;
      skipped++;
    }
  }
  return { toImport, skipped, kindCounts, skipCounts };
}

/** Re-export VaultCliError for the CLI wrapper. */
export { VaultCliError, resolveConfig };

/**
 * Run a full import-env pass. Builds plan, optionally executes it, and
 * returns a structured summary the CLI layer can print.
 *
 * Network ops:
 *   - GET /api/vault/entries (for dedup; via listEntries)
 *   - PUT /api/vault/entries/:id per imported row (only when execute=true)
 */
export async function runImportEnv(
  opts: ImportEnvOptions,
  io?: {
    /** Optional listEntries override for tests. */
    listEntriesFn?: (cfg: VaultClientConfig) => Promise<VaultEntrySummary[]>;
    addEntryFn?: (cfg: VaultClientConfig, args: AddEntryArgs) => Promise<AddEntryResult>;
    onProgress?: (row: PlanRow, ok: boolean, err?: string) => void;
    /** Called once when dedup is skipped due to missing auth (dry-run only). */
    onDedupSkipped?: (reason: string) => void;
  },
): Promise<ImportEnvResultSummary> {
  // Auth is required for --execute; for dry-run we'll degrade gracefully if a
  // token is missing or `listEntries` errors (so the user can preview without
  // a live JWT). The dedup check is just lossy in that path.
  const tokenAvailable = !!(opts.token ?? process.env.OPTIMAL_FABRIC_TOKEN);
  let cfg: VaultClientConfig | null = null;
  if (opts.execute || tokenAvailable) {
    cfg = resolveConfig({ token: opts.token, cloud: opts.cloud });
  }
  const { files, missing } = resolveSourceFiles(opts.files);

  let existingLabels = new Set<string>();
  if (cfg) {
    const listFn = io?.listEntriesFn ?? listEntries;
    try {
      const existing = await listFn(cfg);
      existingLabels = new Set(existing.map((e) => e.label));
    } catch (e) {
      if (opts.execute) {
        if (e instanceof VaultCliError) throw e;
        throw new VaultCliError(
          "Failed to list existing vault entries for dedup",
          (e as Error)?.message ?? String(e),
        );
      }
      // dry-run: degrade — emit warning, leave existingLabels empty
      io?.onDedupSkipped?.(
        `dedup skipped (could not reach vault): ${(e as Error)?.message ?? String(e)}`,
      );
    }
  } else {
    io?.onDedupSkipped?.(
      "dedup skipped: no OPTIMAL_FABRIC_TOKEN set (dry-run only). Set the token to enable already-in-vault detection.",
    );
  }

  const { rows, missingFiles } = buildPlan({
    files,
    existingLabels,
    includeUrls: opts.includeUrls,
    extraSkipKeys: new Set(opts.skipKeys),
    missing,
  });

  const summary = summarize(rows);
  let imported = 0;
  let failed: Array<{ label: string; error: string }> = [];
  if (opts.execute) {
    if (!cfg) {
      // Defensive — should never happen since we threw earlier
      throw new VaultCliError(
        "Cannot execute imports without a Fabric JWT",
        "Set OPTIMAL_FABRIC_TOKEN or pass --token.",
      );
    }
    const exec = await executePlan(cfg, rows, {
      addEntryFn: io?.addEntryFn,
      onProgress: io?.onProgress,
    });
    imported = exec.imported;
    failed = exec.failed;
  }
  return {
    toImport: summary.toImport,
    skipped: summary.skipped,
    imported,
    failed,
    missingFiles,
    rows,
    kindCounts: summary.kindCounts,
    skipCounts: summary.skipCounts,
  };
}
