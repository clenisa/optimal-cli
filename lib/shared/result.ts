export interface OpResult<T = void> {
  ok: boolean;
  data?: T;
  warnings: string[];
  errors: string[];
}

export function success<T>(data: T, warnings: string[] = []): OpResult<T> {
  return { ok: true, data, warnings, errors: [] };
}

export function failure(errors: string[], warnings: string[] = []): OpResult {
  return { ok: false, warnings, errors };
}
