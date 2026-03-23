import { randomUUID } from 'crypto';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
}

let currentTraceId: string | null = null;

export function startTrace(command: string): Span {
  currentTraceId = randomUUID().replace(/-/g, '').slice(0, 32);
  return startSpan(command);
}

export function startSpan(operation: string, parent?: Span): Span {
  return {
    traceId: currentTraceId || randomUUID().replace(/-/g, '').slice(0, 32),
    spanId: randomUUID().replace(/-/g, '').slice(0, 16),
    parentSpanId: parent?.spanId,
    operation,
    startTime: Date.now(),
    attributes: {},
  };
}

export function endSpan(span: Span, status: 'ok' | 'error' = 'ok'): void {
  const duration = Date.now() - span.startTime;
  const log = {
    level: status === 'error' ? 'error' : 'info',
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    operation: span.operation,
    duration_ms: duration,
    status,
    ...span.attributes,
    timestamp: new Date().toISOString(),
  };
  process.stderr.write(JSON.stringify(log) + '\n');
}
