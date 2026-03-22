# n8n ReturnPro Pipeline — Webhook 404

## Problem
`POST /webhook/returnpro-pipeline` returns 404 despite the workflow "ReturnPro — Pipeline (Master Orchestrator)" (ID: `EuahDWlxuFIPBb94`) showing as active in the n8n database.

## Impact
- `optimal run-pipeline` CLI command fails — cannot trigger the ReturnPro audit/anomaly/dims pipeline
- Individual sub-webhooks (audit, anomaly-scan, dims-check, notify) were not tested

## Possible Causes
1. Workflow was edited/saved but webhook not re-registered (n8n requires deactivate→activate to re-register webhooks after edits)
2. n8n restart didn't pick up the webhook registration
3. Webhook path in the workflow node doesn't match `/webhook/returnpro-pipeline`

## Fix Steps
1. Open n8n UI at https://n8n.optimal.miami
2. Find "ReturnPro — Pipeline (Master Orchestrator)"
3. Toggle it OFF then ON (deactivate → activate)
4. Test: `curl -X POST http://localhost:5678/webhook/returnpro-pipeline -H "Content-Type: application/json" -d '{"test": true}'`
5. If still 404, open the Webhook node and verify the path is exactly `returnpro-pipeline`

## Related
- CLI command: `optimal run-pipeline --month YYYY-MM`
- Implementation: `lib/returnpro/pipeline.ts`
- Sub-workflows: anomaly-scan, audit, dims-check, notify (all on separate webhooks)
