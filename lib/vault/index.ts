/**
 * OptimalVault CLI — credential ops against fabric.optimal.miami.
 *
 * The CLI is a thin write-client: it fetches the cloud's current age public
 * keys (which are public by design), encrypts the value to all of them
 * client-side, and PUTs the ciphertext. The cloud never sees plaintext.
 *
 * Auth: requires a Fabric JWT in `OPTIMAL_FABRIC_TOKEN` (or --token flag).
 * Get one from the iPhone Safari devtools after vault setup ceremony, or
 * curl /api/auth/setup-init with INVITE_PASSWORD on a fresh vault.
 */
import { Encrypter } from "age-encryption";
import { randomUUID, createHash } from "node:crypto";

export type VaultEntryKind = "api_key" | "oauth_refresh" | "ssh_key" | "env_blob";

export interface VaultRecipient {
  id: string;
  kind: "browser" | "device" | "recovery";
  pubkey: string;
  label: string | null;
  device_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface VaultEntrySummary {
  id: string;
  label: string;
  kind: VaultEntryKind;
  recipients_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface VaultClientConfig {
  cloudUrl: string;
  token: string;
}

export class VaultCliError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "VaultCliError";
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function listRecipients(cfg: VaultClientConfig): Promise<VaultRecipient[]> {
  const res = await fetch(`${cfg.cloudUrl}/api/vault/recipients`, {
    headers: authHeaders(cfg.token),
  });
  if (res.status === 401)
    throw new VaultCliError(
      "Unauthorized fetching recipients",
      "Token expired or invalid. Set OPTIMAL_FABRIC_TOKEN with a fresh JWT.",
    );
  if (!res.ok) {
    const body = await res.text();
    throw new VaultCliError(`GET /api/vault/recipients failed: HTTP ${res.status}`, body);
  }
  const json = (await res.json()) as VaultRecipient[];
  return json;
}

export async function listEntries(cfg: VaultClientConfig): Promise<VaultEntrySummary[]> {
  const res = await fetch(`${cfg.cloudUrl}/api/vault/entries`, {
    headers: authHeaders(cfg.token),
  });
  if (res.status === 401)
    throw new VaultCliError(
      "Unauthorized listing entries",
      "Token expired or invalid. Set OPTIMAL_FABRIC_TOKEN with a fresh JWT.",
    );
  if (!res.ok) {
    const body = await res.text();
    throw new VaultCliError(`GET /api/vault/entries failed: HTTP ${res.status}`, body);
  }
  return (await res.json()) as VaultEntrySummary[];
}

export interface AddEntryArgs {
  label: string;
  kind: VaultEntryKind;
  value: string;
  metadata?: Record<string, unknown>;
}

export interface AddEntryResult {
  id: string;
  recipientCount: number;
  recipients: Array<{ kind: string; label: string | null; pubkey: string }>;
}

export async function addEntry(cfg: VaultClientConfig, args: AddEntryArgs): Promise<AddEntryResult> {
  const recipients = await listRecipients(cfg);
  const active = recipients.filter((r) => !r.revoked_at);
  if (active.length === 0)
    throw new VaultCliError(
      "No active recipients in vault — cannot encrypt",
      "Walk the /vault/setup ceremony in a browser before adding entries.",
    );

  // age-encrypt to every active recipient. Any of them can decrypt.
  const enc = new Encrypter();
  for (const r of active) enc.addRecipient(r.pubkey);
  const ciphertext = await enc.encrypt(new TextEncoder().encode(args.value));

  // recipients_hash matches server convention: sha256 of sorted pubkeys joined by \n.
  const sortedPubkeys = active.map((r) => r.pubkey).sort();
  const recipients_hash = createHash("sha256").update(sortedPubkeys.join("\n")).digest("hex");

  const id = randomUUID();
  const res = await fetch(`${cfg.cloudUrl}/api/vault/entries/${id}`, {
    method: "PUT",
    headers: authHeaders(cfg.token),
    body: JSON.stringify({
      label: args.label,
      kind: args.kind,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      recipients_hash,
      metadata: args.metadata ?? {},
    }),
  });
  if (res.status === 401)
    throw new VaultCliError(
      "Unauthorized writing entry",
      "Token lacks vault:write scope, or expired. Re-mint via /api/auth/setup-init or grab a fresh JWT from browser.",
    );
  if (!res.ok) {
    const body = await res.text();
    throw new VaultCliError(`PUT /api/vault/entries/${id} failed: HTTP ${res.status}`, body);
  }
  return {
    id,
    recipientCount: active.length,
    recipients: active.map((r) => ({ kind: r.kind, label: r.label, pubkey: r.pubkey })),
  };
}

export function resolveConfig(opts: { token?: string; cloud?: string }): VaultClientConfig {
  const token = opts.token ?? process.env.OPTIMAL_FABRIC_TOKEN;
  if (!token) {
    throw new VaultCliError(
      "Missing Fabric JWT",
      "Set OPTIMAL_FABRIC_TOKEN env, or pass --token. Grab a JWT from iPhone Safari devtools after vault unlock (localStorage → vault session token), or run setup-init with INVITE_PASSWORD.",
    );
  }
  const cloudUrl = (opts.cloud ?? process.env.OPTIMAL_FABRIC_URL ?? "https://fabric.optimal.miami").replace(/\/$/, "");
  return { token, cloudUrl };
}

export const VAULT_ENTRY_KINDS: VaultEntryKind[] = ["api_key", "oauth_refresh", "ssh_key", "env_blob"];

export function assertEntryKind(kind: string): asserts kind is VaultEntryKind {
  if (!VAULT_ENTRY_KINDS.includes(kind as VaultEntryKind)) {
    throw new VaultCliError(
      `Invalid kind "${kind}"`,
      `Expected one of: ${VAULT_ENTRY_KINDS.join(", ")}`,
    );
  }
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.replace(/\n$/, "")));
    process.stdin.on("error", reject);
  });
}
