# Optimal CLI — Full Command Reference

## Global Options

All commands support:
- `-V, --version` — Show version number
- `-h, --help` — Show help

---

## Config Commands

### `optimal config push`
Push local `~/.openclaw/openclaw.json` to cloud storage.

```bash
optimal config push --agent <name>
```

**Options:**
- `--agent <name>` (required) — Agent name (e.g., oracle, opal, kimklaw)

**Example:**
```bash
optimal config push --agent oracle
# ✓ Config pushed for oracle
#   ID: abc-123
#   Version: 2026-03-05T12:00:00Z
```

---

### `optimal config pull`
Pull config from cloud and save to local `~/.openclaw/openclaw.json`.

```bash
optimal config pull --agent <name>
```

**Options:**
- `--agent <name>` (required) — Agent name to pull config for

**Example:**
```bash
optimal config pull --agent oracle
# ✓ Config pulled for oracle
#   Version: 2026-03-05T12:00:00Z
#   Updated: 2026-03-05T12:00:00Z
# 
# Saved to: ~/.openclaw/openclaw.json
```

---

### `optimal config list`
List all saved agent configs in cloud storage.

```bash
optimal config list
```

**Example:**
```bash
optimal config list
# | Agent   | Version              | Updated              |
# |---------|----------------------|----------------------|
# | oracle  | 2026-03-05T10:00:00Z | 2026-03-05T10:00:00Z |
# | opal    | 2026-03-04T08:30:00Z | 2026-03-04T08:30:00Z |
# | kimklaw | 2026-03-05T11:15:00Z | 2026-03-05T11:15:00Z |
# 
# Total: 3 configs
```

---

### `optimal config diff`
Compare local config with cloud version.

```bash
optimal config diff --agent <name>
```

**Options:**
- `--agent <name>` (required) — Agent name to compare

**Example:**
```bash
optimal config diff --agent oracle
# Differences found:
#   • Top-level keys differ
#   • Version mismatch: local=2026.2.25, cloud=2026.3.1
# 
# Local updated: 2026-03-05T10:00:00Z
# Cloud updated: 2026-03-05T12:00:00Z
```

---

### `optimal config sync`
Two-way sync: push if local is newer, pull if cloud is newer.

```bash
optimal config sync --agent <name>
```

**Options:**
- `--agent <name>` (required) — Agent name to sync

**Example:**
```bash
optimal config sync --agent oracle
# ✓ pushed
#   Local is newer - pushed to cloud (version 2026-03-05T12:00:00Z)
```

---

## Board Commands

### `optimal board view`
Display the kanban board.

```bash
optimal board view [options]
```

**Options:**
- `-p, --project <slug>` — Project slug (default: optimal-cli-refactor)
- `-s, --status <status>` — Filter by status

**Example:**
```bash
optimal board view
# | Status      | P | Title                | Agent   | Skill       |
# |-------------|---|----------------------|---------|-------------|
# | in_progress | 1 | Build CLI            | oracle  | config-sync |
# | ready       | 2 | Test migrations      | kimklaw | db-migrate  |
```

---

### `optimal board create`
Create a new task.

```bash
optimal board create --title "Task name" [options]
```

**Options:**
- `-t, --title <title>` (required) — Task title
- `-p, --project <slug>` — Project slug (default: optimal-cli-refactor)
- `-d, --description <desc>` — Task description
- `--priority <n>` — Priority 1-4 (default: 3)
- `--skill <ref>` — Skill reference
- `--labels <labels>` — Comma-separated labels

**Example:**
```bash
optimal board create --title "Fix bug" --priority 1 --skill config-sync
```

---

### `optimal board update`
Update a task.

```bash
optimal board update --id <uuid> [options]
```

**Options:**
- `--id <uuid>` (required) — Task UUID
- `-s, --status <status>` — New status
- `-a, --agent <name>` — Assign to agent
- `--priority <n>` — New priority
- `-m, --message <msg>` — Log message

**Example:**
```bash
optimal board update --id abc-123 --status done --agent oracle
```

---

### `optimal board sync:push`
Push obsidian tasks to supabase.

```bash
optimal board sync:push [options]
```

**Options:**
- `--dry-run` — Show what would be synced without writing (default: true)

**Example:**
```bash
optimal board sync:push
# [dry-run] Would create: Fix bug
# [dry-run] Would update: Add tests
```

---

### `optimal board sync:pull`
Pull supabase tasks to obsidian markdown.

```bash
optimal board sync:pull [options]
```

**Options:**
- `--dry-run` — Show what would be pulled without writing (default: false)
- `--project <slug>` — Filter by project slug

**Example:**
```bash
optimal board sync:pull --dry-run
# Syncing from Supabase → Obsidian...
# [dry-run] Would create: task__fix-bug__a1b2c3d4.md
```

---

### `optimal board sync:status`
Show diff between supabase and obsidian tasks.

```bash
optimal board sync:status
```

**Example:**
```bash
optimal board sync:status
# Supabase tasks: 12
# Obsidian tasks: 15
# Only in Supabase: ["Fix bug"]
# Only in Obsidian: ["Add tests", "Update docs"]
```

---

## Database Migration Commands

### `optimal migrate push`
Run Supabase migrations.

```bash
optimal migrate push --target <returnpro|optimalos> [options]
```

**Options:**
- `--target <target>` (required) — Target: returnpro or optimalos
- `--dry-run` — Preview without applying

---

### `optimal migrate pending`
List pending migration files.

```bash
optimal migrate pending --target <returnpro|optimalos>
```

---

### `optimal migrate create`
Create a new migration file.

```bash
optimal migrate create --target <returnpro|optimalos> --name <name>
```

---

## Environment Setup

### Required for Config Sync

```bash
# ~/.optimal/.env
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...
```

### Required for Financial Commands

```bash
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=sb_secret_...
```

### Required for CMS Commands

```bash
STRAPI_URL=https://strapi.optimal.miami
STRAPI_API_TOKEN=your_token_here
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Missing required option |
| 3 | Authentication failed |

---

## Troubleshooting

### "No config found at ~/.openclaw/openclaw.json"
Run `optimal config pull --agent <name>` to download a config first.

### "Missing OPTIMAL_SUPABASE_SERVICE_KEY"
Set the environment variable in `~/.optimal/.env`.

### "Table does not exist"
Run the migration SQL in Supabase SQL Editor (see README.md).