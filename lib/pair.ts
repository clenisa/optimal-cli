/**
 * `optimal pair` — device pairing CLI for OptimalOS Fabric.
 *
 * Workflow:
 *   1. User completes vault setup in browser, then visits /pair to mint a
 *      one-time pairing JWT via POST /api/auth/devices/pair-init (10-minute TTL).
 *   2. User pastes the pairing JWT into `optimal pair --token <jwt>` on the
 *      device they want to enroll.
 *   3. This CLI generates (or loads) an x25519 keypair persisted at
 *      ~/.config/optimalos/keys/device.key (mode 0600), POSTs the public
 *      recipient + label + capabilities to /api/auth/devices/pair-complete,
 *      and stores the returned 30-day device JWT at ~/.config/optimalos/device.jwt
 *      (mode 0600). The device is now a registered Fabric recipient and can
 *      receive vault entries on the next eager-rewrap pass.
 *
 * The cloud never sees the device's private key. The pairing JWT is consumed
 * single-use by the cloud's pair-complete endpoint.
 */

import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as tls from "node:tls";

import { VaultCliError } from "./vault/index.js";

export interface PairOptions {
  pairingToken: string;
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
   * Skip TOFU pin capture during pair (default: false). Set true for tests
   * that mock fetch and don't want to open a real TLS connection. Even when
   * skipped, the device daemon's pinning fetch will TOFU on first cloud
   * request, so the pin still gets captured — just not during pair.
   */
  skipPinCapture?: boolean;
}

export interface PairResult {
  deviceId: string;
  recipientId: string;
  expiresAt: string;
  ageRecipient: string;
  keyPath: string;
  jwtPath: string;
  generatedFreshKey: boolean;
  /**
   * SHA-256 of the cloud's TLS SubjectPublicKeyInfo, captured during the
   * pair ceremony and persisted next to the device JWT for TOFU origin
   * pinning (cross-references optimalOS Phase 10a-7 / threat-audit P1 #10
   * / T7). Null when the pair ran against http:// (tests) or when capture
   * failed for any reason — pinning is best-effort during pair, the device
   * daemon's `makePinningFetch` will TOFU on first connect either way.
   */
  cloudPinSha256: string | null;
  /** Path the pin was persisted to, or null if no pin captured. */
  pinPath: string | null;
}

export interface DeviceKeyPair {
  /** AGE-SECRET-KEY-1... */
  identity: string;
  /** age1... */
  recipient: string;
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

/**
 * Open a one-shot TLS connection to `host:port` to peek the server cert,
 * compute the SHA-256 of its SubjectPublicKeyInfo, and resolve with the hex
 * hash. Resolves to `null` on any failure — pin capture is best-effort and
 * must NOT block the pair ceremony (the device daemon's `makePinningFetch`
 * will TOFU on first connect anyway).
 *
 * Uses `rejectUnauthorized: true` so the cert must validate against the
 * system CA chain — pin ⊕ CA. Captures the SPKI from
 * `getPeerCertificate()` (DER-encoded SubjectPublicKeyInfo via
 * the `pubkey` field, matching RFC 7469 / Chromium static pin lists).
 */
export async function captureCloudPin(
  host: string,
  port = 443,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      // RFC 6066 forbids setting servername to an IP literal; omit it in that
      // case so the TLS handshake doesn't warn / future-error.
      const isIpLiteral = /^[0-9.]+$|:/.test(host);
      const socket = tls.connect(
        {
          host,
          port,
          ...(isIpLiteral ? {} : { servername: host }),
          rejectUnauthorized: true,
        },
        () => {
          try {
            const cert = socket.getPeerCertificate();
            if (!cert || !cert.pubkey || cert.pubkey.length === 0) {
              finish(null);
            } else {
              const hex = createHash("sha256").update(cert.pubkey).digest("hex");
              finish(hex);
            }
          } catch {
            finish(null);
          } finally {
            socket.end();
          }
        },
      );
      socket.on("error", () => finish(null));
      socket.setTimeout(8000, () => {
        socket.destroy();
        finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

/** Persist the cloud pin (mode 0644 — public hash). */
async function persistCloudPin(pinHex: string, path: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await fs.writeFile(path, pinHex.toLowerCase() + "\n", { mode: 0o644 });
}

/**
 * Read an existing device key from disk. Returns null if not found.
 * Throws if the file exists but doesn't look like an AGE-SECRET-KEY.
 */
export async function loadDeviceKey(path: string): Promise<DeviceKeyPair | null> {
  if (!existsSync(path)) return null;
  const raw = (await fs.readFile(path, "utf-8")).trim();
  if (!raw.startsWith("AGE-SECRET-KEY-1")) {
    throw new VaultCliError(
      `Device key file ${path} does not contain an AGE-SECRET-KEY-1... string`,
      "Delete the file and re-run pair to generate a fresh keypair.",
    );
  }
  const recipient = await identityToRecipient(raw);
  return { identity: raw, recipient };
}

/**
 * Generate a fresh x25519 keypair, persist it (mode 0600), and return both
 * halves. Creates parent dirs as needed.
 */
export async function generateAndPersistDeviceKey(
  path: string,
): Promise<DeviceKeyPair> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, identity + "\n", { mode: 0o600 });
  return { identity, recipient };
}

/**
 * Load existing key or generate a fresh one. Returns whether the key was
 * freshly generated so the caller can warn the user.
 */
export async function loadOrCreateDeviceKey(
  path: string,
): Promise<{ key: DeviceKeyPair; freshlyGenerated: boolean }> {
  const existing = await loadDeviceKey(path);
  if (existing) return { key: existing, freshlyGenerated: false };
  const fresh = await generateAndPersistDeviceKey(path);
  return { key: fresh, freshlyGenerated: true };
}

interface PairCompleteResponse {
  deviceToken: string;
  recipientId: string;
  deviceId: string;
  expiresAt: string;
  eagerRewrapRequired: boolean;
}

/**
 * Run the full pair ceremony: load/generate key, POST pair-complete, save JWT.
 */
export async function pairDevice(opts: PairOptions): Promise<PairResult> {
  const keyPath = opts.keyPath ?? defaultKeyPath();
  const jwtPath = opts.jwtPath ?? defaultJwtPath();
  const label = (opts.label ?? hostname()).trim();
  if (!label) {
    throw new VaultCliError(
      "Empty device label",
      "Pass --label or ensure os.hostname() returns a non-empty value.",
    );
  }

  const { key, freshlyGenerated } = await loadOrCreateDeviceKey(keyPath);

  const url = `${opts.cloudUrl.replace(/\/$/, "")}/api/auth/devices/pair-complete`;
  const body: Record<string, unknown> = {
    pairingToken: opts.pairingToken,
    devicePubkey: key.recipient,
    deviceLabel: label,
  };
  if (opts.capabilities && opts.capabilities.length > 0) {
    body.capabilities = opts.capabilities;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VaultCliError(
      `Cannot reach Fabric cloud at ${opts.cloudUrl}`,
      `Network error: ${(err as Error).message}. Check OPTIMAL_FABRIC_URL and that the cloud is up.`,
    );
  }

  if (res.status === 401) {
    const text = await res.text();
    throw new VaultCliError(
      "Pairing token rejected (401)",
      `Cloud said: ${text}. Token may be expired (10-min TTL), already used, or signed by a stale JWT key.`,
    );
  }
  if (res.status === 410) {
    throw new VaultCliError(
      "Pairing token already used (410)",
      "Generate a fresh pairing token from the browser /pair page.",
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new VaultCliError(
      `pair-complete failed: HTTP ${res.status}`,
      text,
    );
  }

  const data = (await res.json()) as PairCompleteResponse;
  if (!data.deviceToken || !data.deviceId || !data.recipientId) {
    throw new VaultCliError(
      "pair-complete returned an incomplete response",
      `Got: ${JSON.stringify(data)}`,
    );
  }

  await fs.mkdir(dirname(jwtPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(jwtPath, data.deviceToken + "\n", { mode: 0o600 });

  // TOFU origin pin capture (cross-references optimalOS Phase 10a-7 / P1
  // #10 / T7). Best-effort: failure here logs a warning but does not fail
  // the pair ceremony — the device daemon's `makePinningFetch` will TOFU
  // on first cloud request. Skipped for http:// URLs (test fixtures) and
  // when `skipPinCapture` is set explicitly.
  let cloudPinSha256: string | null = null;
  let pinPathOut: string | null = null;
  const cloudUrlParsed = new URL(opts.cloudUrl);
  if (
    !opts.skipPinCapture &&
    cloudUrlParsed.protocol === "https:"
  ) {
    const pinPath = opts.pinPath ?? defaultPinPath();
    const port = cloudUrlParsed.port ? Number(cloudUrlParsed.port) : 443;
    const captured = await captureCloudPin(cloudUrlParsed.hostname, port);
    if (captured) {
      try {
        await persistCloudPin(captured, pinPath);
        cloudPinSha256 = captured;
        pinPathOut = pinPath;
      } catch (err) {
        console.warn(
          `pair: TOFU pin capture succeeded but persistence to ${pinPath} failed (${(err as Error).message}). Daemon will TOFU on first connect.`,
        );
      }
    } else {
      console.warn(
        `pair: TOFU pin capture for ${cloudUrlParsed.hostname}:${port} returned no cert. Daemon will TOFU on first connect.`,
      );
    }
  }

  return {
    deviceId: data.deviceId,
    recipientId: data.recipientId,
    expiresAt: data.expiresAt,
    ageRecipient: key.recipient,
    keyPath,
    jwtPath,
    generatedFreshKey: freshlyGenerated,
    cloudPinSha256,
    pinPath: pinPathOut,
  };
}
