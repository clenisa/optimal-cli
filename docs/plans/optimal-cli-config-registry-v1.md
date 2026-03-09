# optimal-cli shared config registry v1 (draft)

## objective
define a repeatable config-sharing model for `optimal-cli` with versioned schema, supabase-backed sync, and clear command surface.

## v1 scope
- single-user + team-ready config profile storage
- deterministic import/export format
- pull/push sync with conflict visibility
- schema migration path (`version` field)

## config schema (v1)
```json
{
  "version": "1.0.0",
  "profile": {
    "name": "default",
    "owner": "clenisa",
    "updated_at": "2026-03-05T04:40:00-05:00"
  },
  "providers": {
    "supabase": {
      "project_ref": "<ref>",
      "url": "<url>",
      "anon_key_present": true
    },
    "strapi": {
      "base_url": "https://strapi.optimal.miami",
      "token_present": true
    }
  },
  "defaults": {
    "brand": "CRE-11TRUST",
    "timezone": "America/New_York"
  },
  "features": {
    "cms": true,
    "tasks": true,
    "deploy": false
  }
}
```

## supabase model (proposed)
`cli_config_registry`
- `id uuid pk`
- `owner text not null`
- `profile_name text not null`
- `schema_version text not null`
- `config_json jsonb not null`
- `config_hash text not null`
- `updated_at timestamptz not null default now()`
- unique `(owner, profile_name)`

## command surface (v1)
- `optimal config init [--profile default]`
- `optimal config export --out ./optimal.config.json`
- `optimal config import --file ./optimal.config.json [--merge|--replace]`
- `optimal config sync pull [--profile default]`
- `optimal config sync push [--profile default] [--force]`
- `optimal config doctor`

## conflict model
- compare local `config_hash` vs remote `config_hash`
- if diverged and no `--force`, abort with resolution hints
- write pull/merge decisions to local audit log (`~/.optimal/config-history.log`)

## next implementation step
1. add `lib/config/schema.ts` + zod validator
2. add `bin/optimal.ts` `config` command group with `doctor` + `export`
3. scaffold supabase read/write adapter in `lib/config/registry.ts`
