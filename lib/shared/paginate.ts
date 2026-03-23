import { CliError } from '../errors.js';

const DEFAULT_PAGE_SIZE = 1000;

export async function paginateAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new CliError(`Pagination failed at offset ${from}: ${error.message}`, 'SUPABASE_ERROR');
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return results;
}
