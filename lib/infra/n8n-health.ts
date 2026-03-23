// lib/infra/n8n-health.ts

export interface WebhookHealthResult {
  path: string;
  name: string;
  status: 'ok' | 'unregistered' | 'unreachable';
  httpStatus?: number;
  error?: string;
}

const EXPECTED_WEBHOOKS = [
  { path: '/webhook/social-post-publish', name: 'Social Post Publisher' },
  { path: '/webhook/newsletter-distribute', name: 'Newsletter Distributor' },
  { path: '/webhook/returnpro-pipeline', name: 'ReturnPro Pipeline' },
];

export async function checkN8nWebhooks(): Promise<WebhookHealthResult[]> {
  const baseUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n.optimal.miami';
  const results: WebhookHealthResult[] = [];

  for (const webhook of EXPECTED_WEBHOOKS) {
    const url = `${baseUrl}${webhook.path}`;
    try {
      // Use GET to probe without triggering — n8n webhooks respond differently to GET vs POST
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        ...webhook,
        status: res.status === 404 ? 'unregistered' : 'ok',
        httpStatus: res.status,
      });
    } catch (err) {
      results.push({
        ...webhook,
        status: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
