/**
 * `optimal pair --device-grant` — RFC 8628 OAuth 2.0 Device Authorization
 * Grant flow for OptimalOS Fabric.
 *
 * Strictly additive to `lib/pair.ts` (token-paste). Same key/JWT outputs;
 * only the auth ceremony differs:
 *
 *   1. POST /api/auth/devices/oauth/code  → server returns `{ device_code,
 *      user_code, verification_uri, verification_uri_complete, expires_in,
 *      interval }`.
 *   2. CLI prints the user_code + URL and starts polling.
 *   3. POST /api/auth/devices/oauth/token (every `interval` seconds)
 *      → 400 `authorization_pending`  → wait `interval`s and retry
 *      → 400 `slow_down`              → bump `interval` by +5s and retry
 *      → 400 `access_denied`          → fail with a clean message
 *      → 400 `expired_token`          → fail with "code expired"
 *      → 200                          → success, persist JWT, return
 *
 * Source-of-truth: RFC 8628 §3.5.
 */

import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { existsSync } from "node:fs";

import { VaultCliError } from "./vault/index.js";
// Reuse pair.ts helpers — the device-key dance + cloud-pin capture is
// identical to the legacy flow.
import {
  captureCloudPin,
  loadOrCreateDeviceKey,
  type DeviceKeyPair,
  type PairResult,
} from "./pair.js";

export interface PairDeviceGrantOptions {
  cloudUrl: string;
  label?: string;
  capabilities?: string[];
  /** Override key file path (tests). */
  keyPath?: string;
  /** Override JWT file path (tests). */
  jwtPath?: string;
  /** Override cloud-pin file path (tests). */
  pinPath?: string;
  /**
   * Skip TOFU pin capture during pair (default: false). Same semantics as
   * `pairDevice` — pin capture is best-effort either way.
   */
  skipPinCapture?: boolean;
  /**
   * User-visible callback for the device-grant ceremony. The CLI prints
   * the user_code + URL the operator should visit. Tests inject a stub.
   */
  onPrompt?: (info: DeviceGrantPrompt) => void;
  /**
   * Polling tick callback — invoked once per poll attempt. Lets the CLI
   * draw a spinner / countdown. Tests assert on call counts.
   */
  onPoll?: (status: DeviceGrantPollStatus) => void;
  /**
   * Override the server-supplied `interval`. Useful in tests to avoid
   * actually waiting 5s between polls.
   */
  intervalSecOverride?: number;
  /**
   * Cap the total polling duration (defaults to the server's `expires_in`).
   * Tests use a tiny value to drive the timeout branch.
   */
  maxPollSecOverride?: number;
}

export interface DeviceGrantPrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSec: number;
  intervalSec: number;
}

export type DeviceGrantPollStatus =
  | { kind: "polling"; attempt: number; nextWaitSec: number }
  | { kind: "slow_down"; intervalSec: number };

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenSuccessResponse {
  deviceToken: string;
  recipientId: string;
  deviceId: string;
  expiresAt: string;
  eagerRewrapRequired: boolean;
}

interface TokenErrorResponse {
  error:
    | "authorization_pending"
    | "slow_down"
    | "access_denied"
    | "expired_token"
    | string;
}

function defaultKeyPath(): string {
  return join(homedir(), ".config", "optimalos", "keys", "device.key");
}
function defaultJwtPath(): string {
  return join(homedir(), ".config", "optimalos", "device.jwt");
}
function defaultPinPath(): string {
  return join(homedir(), ".config", "optimalos", "cloud-pin.sha256");
}

/** Sleep helper. Exported for tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Step 1 — request a device_code + user_code from the cloud.
 */
export async function requestDeviceCode(
  cloudUrl: string,
  body: { clientLabel?: string; capabilities?: string[] },
): Promise<CodeResponse> {
  const url = `${cloudUrl.replace(/\/$/, "")}/api/auth/devices/oauth/code`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VaultCliError(
      `Cannot reach Fabric cloud at ${cloudUrl}`,
      `Network error: ${(err as Error).message}. Check OPTIMAL_FABRIC_URL and that the cloud is up.`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new VaultCliError(
      `oauth/code failed: HTTP ${res.status}`,
      text,
    );
  }
  const data = (await res.json()) as CodeResponse;
  if (!data.device_code || !data.user_code) {
    throw new VaultCliError(
      "oauth/code returned an incomplete response",
      `Got: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

/**
 * Step 2 — poll the token endpoint per RFC 8628 §3.5 until success / failure.
 *
 * The server enforces `slow_down` if we poll faster than the supplied
 * `interval`. We respect that: on every `slow_down` we add +5s to our local
 * interval (RFC 8628 recommendation).
 */
export async function pollDeviceToken(
  cloudUrl: string,
  args: {
    deviceCode: string;
    devicePubkey: string;
    deviceLabel: string;
    capabilities?: string[];
    intervalSec: number;
    maxWaitSec: number;
    /** Bump applied per RFC 8628 slow_down. Defaults to +5s. Tests use 0. */
    slowDownBumpSec?: number;
    onPoll?: PairDeviceGrantOptions["onPoll"];
  },
): Promise<TokenSuccessResponse> {
  const url = `${cloudUrl.replace(/\/$/, "")}/api/auth/devices/oauth/token`;
  // No floor on intervalSec — tests pass 0 to skip sleeping. Real callers
  // get the value from `code.interval` which the server picks (currently 5s).
  let intervalSec = args.intervalSec;
  const startMs = Date.now();
  const deadlineMs = startMs + args.maxWaitSec * 1000;
  let attempt = 0;

  while (Date.now() < deadlineMs) {
    attempt += 1;
    args.onPoll?.({ kind: "polling", attempt, nextWaitSec: intervalSec });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_code: args.deviceCode,
          devicePubkey: args.devicePubkey,
          deviceLabel: args.deviceLabel,
          capabilities: args.capabilities,
        }),
      });
    } catch (err) {
      throw new VaultCliError(
        `Cannot reach Fabric cloud at ${cloudUrl}`,
        `Network error during poll: ${(err as Error).message}.`,
      );
    }

    if (res.status === 200) {
      return (await res.json()) as TokenSuccessResponse;
    }

    let body: TokenErrorResponse | null = null;
    try {
      body = (await res.json()) as TokenErrorResponse;
    } catch {
      /* empty */
    }
    const errKind = body?.error ?? `HTTP ${res.status}`;

    if (errKind === "authorization_pending") {
      await sleep(intervalSec * 1000);
      continue;
    }
    if (errKind === "slow_down") {
      intervalSec += args.slowDownBumpSec ?? 5; // RFC 8628 §3.5 (default +5s)
      args.onPoll?.({ kind: "slow_down", intervalSec });
      await sleep(intervalSec * 1000);
      continue;
    }
    if (errKind === "access_denied") {
      throw new VaultCliError(
        "Pair denied (access_denied)",
        "An operator denied this code on the verification page.",
      );
    }
    if (errKind === "expired_token") {
      throw new VaultCliError(
        "Pair code expired (expired_token)",
        "Re-run `optimal pair --device-grant` to mint a fresh code.",
      );
    }
    // Unknown error.
    throw new VaultCliError(
      `oauth/token returned an unexpected error: ${errKind}`,
      `HTTP ${res.status}`,
    );
  }

  throw new VaultCliError(
    "Pair timed out before approval",
    "The cloud-issued code expired before an operator approved it. Re-run to mint a fresh one.",
  );
}

async function persistJwt(jwtPath: string, deviceToken: string): Promise<void> {
  await fs.mkdir(dirname(jwtPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(jwtPath, deviceToken + "\n", { mode: 0o600 });
}

async function persistCloudPin(pinHex: string, path: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await fs.writeFile(path, pinHex.toLowerCase() + "\n", { mode: 0o644 });
}

/**
 * Run the full RFC 8628 ceremony end-to-end. Returns the same shape as
 * `pairDevice` so callers (CLI command, tests) can swap implementations
 * without conditionals.
 */
export async function pairDeviceWithGrant(
  opts: PairDeviceGrantOptions,
): Promise<PairResult> {
  const keyPath = opts.keyPath ?? defaultKeyPath();
  const jwtPath = opts.jwtPath ?? defaultJwtPath();
  const label = (opts.label ?? hostname()).trim();
  if (!label) {
    throw new VaultCliError(
      "Empty device label",
      "Pass --label or ensure os.hostname() returns a non-empty value.",
    );
  }

  // Generate / load the device key BEFORE the /code call so we know the
  // pubkey we're going to bind. The /code endpoint doesn't require the
  // pubkey — it gets bound at /token — but doing this first means a
  // failure mode in age-encryption surfaces before the server allocates
  // a code that will then expire unused.
  const keyResult = await loadOrCreateDeviceKey(keyPath);
  const key: DeviceKeyPair = keyResult.key;

  const code = await requestDeviceCode(opts.cloudUrl, {
    clientLabel: label,
    capabilities: opts.capabilities,
  });

  opts.onPrompt?.({
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    verificationUriComplete: code.verification_uri_complete,
    expiresInSec: code.expires_in,
    intervalSec: code.interval,
  });

  const intervalSec = opts.intervalSecOverride ?? code.interval;
  const maxPollSec = opts.maxPollSecOverride ?? code.expires_in;

  const success = await pollDeviceToken(opts.cloudUrl, {
    deviceCode: code.device_code,
    devicePubkey: key.recipient,
    deviceLabel: label,
    capabilities: opts.capabilities,
    intervalSec,
    maxWaitSec: maxPollSec,
    onPoll: opts.onPoll,
  });

  if (!success.deviceToken || !success.deviceId || !success.recipientId) {
    throw new VaultCliError(
      "oauth/token returned an incomplete success response",
      `Got: ${JSON.stringify(success)}`,
    );
  }

  await persistJwt(jwtPath, success.deviceToken);

  // TOFU pin capture — same best-effort behavior as `pairDevice`.
  let cloudPinSha256: string | null = null;
  let pinPathOut: string | null = null;
  const cloudUrlParsed = new URL(opts.cloudUrl);
  if (!opts.skipPinCapture && cloudUrlParsed.protocol === "https:") {
    const pinPath = opts.pinPath ?? defaultPinPath();
    const port = cloudUrlParsed.port ? Number(cloudUrlParsed.port) : 443;
    const captured = await captureCloudPin(cloudUrlParsed.hostname, port);
    if (captured) {
      try {
        await persistCloudPin(captured, pinPath);
        cloudPinSha256 = captured;
        pinPathOut = pinPath;
      } catch (err) {
        // Persistence failed but the pair succeeded; daemon will TOFU.
        console.warn(
          `pair (device-grant): TOFU pin persistence failed (${(err as Error).message}). Daemon will TOFU on first connect.`,
        );
      }
    }
  }

  // Sanity check that the JWT file actually landed (paranoia for tests).
  if (!existsSync(jwtPath)) {
    throw new VaultCliError(
      "Pair succeeded but JWT file did not persist",
      `Expected ${jwtPath} to exist after writeFile.`,
    );
  }

  return {
    deviceId: success.deviceId,
    recipientId: success.recipientId,
    expiresAt: success.expiresAt,
    ageRecipient: key.recipient,
    keyPath,
    jwtPath,
    generatedFreshKey: keyResult.freshlyGenerated,
    cloudPinSha256,
    pinPath: pinPathOut,
  };
}

// Re-export age helpers for tests that need to seed a fixture key.
export { generateX25519Identity, identityToRecipient };
