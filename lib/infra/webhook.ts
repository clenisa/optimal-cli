// lib/infra/webhook.ts

export interface WebhookResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
  attempts: number;
}

export async function triggerWebhook(
  path: string,
  payload: unknown,
  opts: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<WebhookResult> {
  const { maxRetries = 3, timeoutMs = 10_000 } = opts;
  const baseUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n.optimal.miami';
  const url = `${baseUrl}${path}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 404 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(`Webhook ${path} returned 404 (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }

      return {
        ok: res.ok,
        status: res.status,
        body,
        attempts: attempt,
      };
    } catch (err) {
      if (attempt === maxRetries) {
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : String(err),
          attempts: attempt,
        };
      }
      const delay = 1000 * attempt;
      console.warn(`Webhook ${path} error (attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return { ok: false, status: 0, error: 'Unreachable', attempts: maxRetries };
}
