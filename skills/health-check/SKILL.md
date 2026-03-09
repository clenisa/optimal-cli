---
name: health-check
description: Run the health check script across all Optimal services
---

## Purpose
Run the workstation health check script to verify the status of all Optimal services, Docker containers, and Git repositories.

## Inputs
None.

## Steps
1. Execute `/home/optimal/scripts/health-check.sh` via `lib/infra/deploy.ts::healthCheck()`
2. Script checks each service (timeout: 30 seconds total):
   - **n8n**: Process running check (`pgrep`)
   - **Affine**: Docker container status + HTTP check against `https://affine.op-hub.com`
   - **Strapi CMS**: systemd user service status + HTTP health endpoint on `127.0.0.1:1337/_health`
   - **Git Repositories**: Fetch latest, report uncommitted changes / unpushed commits / behind remote
   - **Docker**: systemd service status + active container count
   - **OptimalOS**: HTTP check on `localhost:3001`
3. Return the full formatted output

## Output
Formatted status report with per-service check/warn/fail indicators:

```
Health Check - 2026-03-01 10:00:00
▸ n8n           -> running on port 5678
▸ Affine        -> running at https://affine.op-hub.com
▸ Strapi CMS    -> running at https://strapi.optimal.miami
▸ Git Repos     -> per-repo sync status
▸ Docker        -> N containers active
▸ OptimalOS     -> dev server on port 3001 (optional)
```

## Usage
```bash
optimal health-check
```

## Environment
Requires: bash, curl, git, docker, systemctl. The script at `/home/optimal/scripts/health-check.sh` must exist.
