/**
 * Content Pipeline Tracing — OpenTelemetry → Phoenix
 *
 * Exports OTEL traces for content pipeline operations (generate, publish,
 * tweet) to Phoenix via OTLP HTTP proto at localhost:6006/v1/traces.
 *
 * Ported from optimalOS src/orchestration/tracing.ts — same Phoenix
 * instance, different service name ("optimal-cli").
 *
 * Integration points:
 *   bin/optimal.ts     → initTracing()   at startup
 *   lib/content/pipeline.ts → withSpan() around generatePost, publishPost
 *   lib/social/twitter.ts   → withSpan() around postTweet
 */

import { trace, SpanStatusCode, context, type Span, type Tracer } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'

// ── Configuration ──────────────────────────────────────────────

const PHOENIX_URL = process.env.PHOENIX_OTLP_URL || 'http://localhost:6006/v1/traces'
const SERVICE_NAME = 'optimal-cli'

// ── Provider setup ─────────────────────────────────────────────

let provider: BasicTracerProvider | null = null
let _tracer: Tracer | null = null

function getTracer(): Tracer | null {
  return _tracer
}

export function initTracing(): void {
  if (provider) return

  const resource = resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': '3.2.0',
    'deployment.environment': 'production',
    'host.name': 'oracle-pi5',
  })

  const exporter = new OTLPTraceExporter({ url: PHOENIX_URL })

  provider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 100,
        maxExportBatchSize: 10,
        scheduledDelayMillis: 5000,
      }),
    ],
  })

  trace.setGlobalTracerProvider(provider)
  _tracer = trace.getTracer(SERVICE_NAME, '3.2.0')
  console.log(`[tracing] Initialized — exporting to ${PHOENIX_URL}`)
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Run an async function inside a named OTEL span. Automatically sets
 * status to OK or ERROR and records exceptions. Child spans created
 * inside `fn` are linked via context propagation.
 *
 * If tracing is not initialized, the function runs without a span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer()
  if (!tracer) return fn(null as unknown as Span)

  const span = tracer.startSpan(name, { attributes })
  const ctx = trace.setSpan(context.active(), span)

  try {
    const result = await context.with(ctx, () => fn(span))
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    })
    span.recordException(err instanceof Error ? err : new Error(String(err)))
    throw err
  } finally {
    span.end()
  }
}

/**
 * Create a child span under the current active context.
 * Use for sub-operations within a withSpan() callback.
 */
export function startChildSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): Span | null {
  const tracer = getTracer()
  if (!tracer) return null

  return tracer.startSpan(name, { attributes })
}

/**
 * Flush pending spans. Call before process exit on long-running operations.
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown()
    provider = null
    _tracer = null
  }
}
