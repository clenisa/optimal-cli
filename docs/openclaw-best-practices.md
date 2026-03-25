# OpenClaw Best Practices — Local Reference

> **Source**: https://docs.openclaw.ai
> **Last synced from docs**: 2026-03-25
> **OpenClaw version at time of sync**: 2026.3.24
> **Next review**: Re-fetch when upgrading OpenClaw or monthly, whichever comes first.

---

## Table of Contents

1. [Configuration](#1-configuration)
2. [Security](#2-security)
3. [Gateway](#3-gateway)
4. [Channels & DM Policies](#4-channels--dm-policies)
5. [Models](#5-models)
6. [Multi-Agent Routing](#6-multi-agent-routing)
7. [Sandboxing & Tool Safety](#7-sandboxing--tool-safety)
8. [Secrets & Credentials](#8-secrets--credentials)
9. [Sessions & Resets](#9-sessions--resets)
10. [Cron, Heartbeat & Automation](#10-cron-heartbeat--automation)
11. [Troubleshooting Checklist](#11-troubleshooting-checklist)
12. [Config Cleanup Checklist](#12-config-cleanup-checklist)

---

## 1. Configuration

### File Location & Format
- Config lives at `~/.openclaw/openclaw.json` (JSON5 supported).
- If missing, safe defaults apply — you don't need a config to start.
- Gateway hot-reloads config on file save (default mode: `"hybrid"`).

### Validation
- OpenClaw enforces **strict schema validation**. Unknown keys, malformed types, or invalid values **prevent Gateway startup**.
- Run `openclaw doctor` to identify issues; `openclaw doctor --fix` for auto-repair.
- Only diagnostic commands work when validation fails.

### CLI Config Helpers
```bash
openclaw config get <path>              # Read a value
openclaw config set <path> <value>      # Set a value
openclaw config unset <path>            # Remove a key
openclaw config validate                # Validate without restart
```

### Config File Splitting
Use `$include` to break large configs into manageable pieces:
```json5
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
}
```
- Single file replaces containing object; array of files deep-merged in order (later wins).
- Supports up to 10 nesting levels.
- Relative paths resolve from the including file.

### Hot Reload Modes
| Mode | Behavior |
|------|----------|
| `"hybrid"` (default) | Hot-applies safe changes, auto-restarts critical ones |
| `"hot"` | Hot-applies safe only, warns when restart needed |
| `"restart"` | Restarts on any change |
| `"off"` | Disables file watching |

**Settings that hot-apply** (no restart): channels, agents, models, routing, hooks, cron, heartbeat, sessions, messages, tools, browser, skills, audio, UI, logging, identity, bindings.

**Settings requiring restart**: gateway server (port, bind, auth, TLS, HTTP), infrastructure (discovery, canvasHost, plugins).

---

## 2. Security

### Core Principle
OpenClaw operates on a **personal assistant security model** — one trusted operator per gateway. It is NOT a multi-tenant security boundary.

> If you need adversarial user separation: use separate gateways + credentials, ideally separate OS users/hosts.

### Authentication (Required)
Gateway auth is required by default. Use one of:

| Mode | How |
|------|-----|
| **Token** (recommended) | `gateway.auth.mode: "token"` + `gateway.auth.token: "<secret>"` |
| **Password** | `OPENCLAW_GATEWAY_PASSWORD` env var |
| **Trusted proxy** | For identity-aware reverse proxies |

### File Permissions
- Config files: `600`
- State directory: `700`

### Network Exposure
- Default bind: `loopback` (local only) — **keep it this way**.
- Non-loopback binds expand attack surface and **require authentication**.
- Prefer **Tailscale Serve** over LAN binds for remote access.

### Prompt Injection Mitigation
- Lock inbound DMs via pairing/allowlists.
- Prefer mention-gating in groups over always-on.
- Treat links, attachments, and pasted instructions as hostile.
- Use **stronger model tiers** for tool-enabled agents (older/smaller models are more susceptible).

### Regular Audits
```bash
openclaw security audit          # Basic audit
openclaw security audit --deep   # Live Gateway probing
```
Checks: auth exposure, browser control, elevated allowlist drift, filesystem permissions, exec approvals, open-channel tool exposure.

### Incident Response
1. **Contain**: Stop process, restrict binding, freeze DM/group policies.
2. **Rotate**: Gateway auth token, remote client credentials, provider/API keys.
3. **Audit**: Review logs, transcripts, rerun `security audit --deep`.

---

## 3. Gateway

### Recommended Startup
```bash
openclaw onboard --install-daemon   # First time (installs systemd/launchd service)
openclaw gateway status             # Verify running
openclaw dashboard                  # Open Control UI
```

### Health Monitoring
```json5
{
  gateway: {
    channelHealthCheckMinutes: 5,
    channelStaleEventThresholdMinutes: 30,
    channelMaxRestartsPerHour: 10,
  },
}
```
Set `channelHealthCheckMinutes: 0` to disable globally. Per-channel override:
```json5
channels: { telegram: { healthMonitor: { enabled: false } } }
```

### Diagnostic Sequence
Run these in order when something's wrong:
```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

---

## 4. Channels & DM Policies

### DM Access Policies
| Policy | Behavior | When to Use |
|--------|----------|-------------|
| `"pairing"` (default) | Unknown senders get one-time code | Personal use, moderate security |
| `"allowlist"` | Only approved senders | High security, known users only |
| `"open"` | All inbound DMs (requires `allowFrom: ["*"]`) | Public-facing bots only |
| `"disabled"` | Ignore all DMs | Channels used only for groups |

### Group Chat
- Use `requireMention: true` for group chats to prevent noise.
- Configure `mentionPatterns` for text-based triggers.
- Supports native metadata mentions and safe regex patterns.

### Channel Config Pattern
```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      allowFrom: ["tg:123"],
    },
  },
}
```

---

## 5. Models

### Provider Format
Always use `provider/model` format:
```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-5.2"],
      },
    },
  },
}
```

### Best Practices
- Configure **fallback models** for resilience.
- Use `agents.defaults.models` to define an allowlist for the `/model` command.
- Set `imageMaxDimensionPx` (default 1200) to control vision token cost.
- Use the **strongest latest-generation model** for agents handling tools or webhook content (prompt injection resistance).

---

## 6. Multi-Agent Routing

### Architecture
Each agent gets:
- Dedicated workspace (`~/.openclaw/workspace-<agentId>`)
- Separate state dir (`~/.openclaw/agents/<agentId>/agent`)
- Independent session store (`~/.openclaw/agents/<agentId>/sessions`)
- Own `auth-profiles.json` (credentials NOT shared across agents)

### Setup
```bash
openclaw agents add coding
openclaw agents add social
openclaw agents list --bindings    # Verify routing
```

### Binding Priority (deterministic)
1. Peer match (exact DM/group/channel ID)
2. Parent peer match (thread inheritance)
3. Guild ID + roles (Discord)
4. Guild ID alone
5. Team ID (Slack)
6. Account ID match
7. Channel-level with `accountId: "*"`
8. Fallback to default agent

> A binding that omits `accountId` matches the default account only. Use `accountId: "*"` for channel-wide fallback.

### Agent-to-Agent Messaging
Disabled by default. Must be explicitly enabled and allowlisted:
```json5
{
  tools: {
    agentToAgent: { enabled: false, allow: ["home", "work"] },
  },
}
```

---

## 7. Sandboxing & Tool Safety

### Sandbox Modes
```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",   // off | non-main | all
        scope: "agent",     // session | agent | shared
      },
    },
  },
}
```
- Requires building the sandbox image first: `scripts/sandbox-setup.sh`
- When sandbox mode is inactive, `tools.exec.host="sandbox"` resolves to **host execution** — be aware.

### Hardened Tool Baseline
From the security docs — deny dangerous tool groups:
- Deny: automation, runtime, filesystem, session spawn/send
- Set exec to `"deny"` mode with `"always"` approval
- Disable elevated tools by default
- Restrict filesystem to workspace-only

### Per-Agent Tool Restrictions
```json5
agents: {
  list: [
    { id: "coding", tools: { allow: ["exec", "filesystem"], deny: ["browser"] } },
  ],
}
```
Note: `tools.elevated` is **global and sender-based** — not per-agent.

---

## 8. Secrets & Credentials

### Secret Reference System
Three source types:
```json5
// Environment variable
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }

// File-based
{ source: "file", provider: "filemain", id: "/skills/entries/image-lab/apiKey" }

// Executable (e.g., Vault)
{ source: "exec", provider: "vault", id: "channels/googlechat/serviceAccount" }
```

### Variable Substitution in Config
```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
}
```
- Only uppercase names: `[A-Z_][A-Z0-9_]*`
- Missing/empty vars **throw error at load time**
- Escape with `$${VAR}` for literal output

### Env Loading Order
1. Parent process environment
2. `.env` (current working directory)
3. `~/.openclaw/.env` (global fallback)

### Sensitive File Locations
| What | Path |
|------|------|
| WhatsApp creds | `~/.openclaw/credentials/whatsapp/<accountId>/creds.json` |
| Telegram/Discord tokens | Config/env or file refs |
| Pairing allowlists | `~/.openclaw/credentials/<channel>-allowFrom.json` |
| Model auth profiles | `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` |

---

## 9. Sessions & Resets

```json5
{
  session: {
    dmScope: "per-channel-peer",   // Prevents cross-user context leakage
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
  },
}
```

### Best Practices
- Use `"per-channel-peer"` for DM scope to prevent cross-user context leakage.
- Enable daily resets to prevent runaway context accumulation.
- Thread bindings with `idleHours: 24` auto-expire stale threads.

---

## 10. Cron, Heartbeat & Automation

### Cron
```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    sessionRetention: "24h",
    runLog: { maxBytes: "2mb", keepLines: 2000 },
  },
}
```
Check status: `openclaw cron status` / `openclaw cron list`

### Heartbeat
```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",   // last | whatsapp | telegram | discord | none
      },
    },
  },
}
```

### Webhooks
```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```
> **Treat webhook payloads as untrusted.** Keep unsafe-content flags disabled unless debugging.

---

## 11. Troubleshooting Checklist

| Symptom | First Check | Fix |
|---------|-------------|-----|
| Gateway won't start | `openclaw doctor` | `openclaw doctor --fix` or fix config manually |
| No replies to messages | `openclaw pairing list --channel <ch>` | Approve pending pairings or check allowlists |
| 429 rate limits (Anthropic) | Check `params.context1m` | Disable context1m or upgrade API plan |
| Dashboard won't connect | Auth token alignment | Match token between client and gateway |
| Channel shows connected but silent | DM policy / mention gating | Check `dmPolicy` and `requireMention` |
| Cron jobs not firing | `openclaw cron status` | Ensure `cron.enabled: true` and scheduler running |
| Post-upgrade breakage | Config drift | `openclaw gateway install --force && openclaw gateway restart` |
| Browser tools failing | `openclaw browser status` | Check executable path and CDP profile |
| Node tools failing | `openclaw nodes status` | Check OS permissions and exec approvals |

---

## 12. Config Cleanup Checklist

Run this periodically to keep your `openclaw.json` clean and secure:

```bash
# 1. Validate config schema
openclaw doctor

# 2. Security audit
openclaw security audit --deep

# 3. Check for unused/stale channel configs
openclaw channels status --probe

# 4. Verify model provider connectivity
openclaw models scan

# 5. Review cron job health
openclaw cron list
openclaw cron status

# 6. Check agent bindings are correct
openclaw agents list --bindings

# 7. Verify file permissions
ls -la ~/.openclaw/openclaw.json        # Should be 600
ls -ld ~/.openclaw/                      # Should be 700
ls -la ~/.openclaw/credentials/          # Should be 600/700

# 8. Review gateway health
openclaw gateway status
openclaw status

# 9. Check for pending pairing approvals
openclaw pairing list --channel telegram
openclaw pairing list --channel discord

# 10. Tail logs for errors
openclaw logs --follow
```

### Config Hygiene Rules
- Remove disabled channels entirely rather than leaving `enabled: false` stubs.
- Use `$include` for configs over ~100 lines.
- Store secrets via SecretRef (`source: "env"`) — never inline plaintext API keys.
- Keep `dmPolicy` as strict as needed (`"pairing"` or `"allowlist"`, not `"open"`).
- Set fallback models — don't rely on a single provider.
- Run `openclaw security audit --deep` after any config change.
- Re-run `openclaw onboard` after major version upgrades.

---

## Quick Reference: Key Commands

| Task | Command |
|------|---------|
| Validate config | `openclaw doctor` |
| Auto-fix config | `openclaw doctor --fix` |
| Security audit | `openclaw security audit --deep` |
| Get config value | `openclaw config get <path>` |
| Set config value | `openclaw config set <path> <value>` |
| Remove config key | `openclaw config unset <path>` |
| Channel health | `openclaw channels status --probe` |
| Search docs | `openclaw docs <query>` |
| Gateway status | `openclaw gateway status` |
| Restart gateway | `openclaw gateway restart` |
| Agent list | `openclaw agents list --bindings` |
| Cron status | `openclaw cron status` |
| Tail logs | `openclaw logs --follow` |
