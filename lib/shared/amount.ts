/**
 * Parse a TEXT amount from stg_financials_raw.
 * Always use this — never raw parseFloat/Number/+ on financial data.
 */
export function parseAmount(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isNaN(num)) return 0;
  return num;
}

export function amountToText(value: number): string {
  return String(value);
}
