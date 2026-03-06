# ReturnPro API Surface

Spec document for building an MCP server on top of the ReturnPro financial data system.

**Supabase Instance:** `https://vvutttwunexshxkmygik.supabase.co`
**Client factory:** `getSupabase('returnpro')` from `lib/supabase.ts`

---

## Tables & Views

| Table / View | Purpose |
|---|---|
| `stg_financials_raw` | Staged financial data. `amount` column is **TEXT** (must `parseFloat` before math). |
| `confirmed_income_statements` | Confirmed GL account rows from NetSuite income statement CSVs. |
| `dim_account` | Account code to account_id lookup; includes `sign_multiplier`. |
| `dim_client` | Client name to client_id lookup. |
| `dim_master_program` | Master program lookup; FK to `dim_client` via `client_id`. |
| `dim_program_id` | Program code to `program_id_key` lookup; FK to `dim_master_program`. |
| `v_rate_anomaly_analysis` | View used by anomaly detection (pre-computed rates, deltas, prior-month comparisons). |

---

## Module: Upload (`upload-netsuite.ts`)

### `processNetSuiteUpload(filePath, userId, options?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/upload-netsuite.ts` |
| **Params** | `filePath: string` — absolute path to `.xlsm`, `.xlsx`, or `.csv` file |
| | `userId: string` — user ID for audit trail |
| | `options?: { months?: string[] }` — optional YYYY-MM filter for multi-sheet XLSM |
| **Returns** | `Promise<NetSuiteUploadResult>` — `{ fileName, loadedAt, inserted, monthsCovered, warnings, error? }` |
| **Tables** | `stg_financials_raw` (write/insert), `dim_master_program` (read), `dim_account` (read), `dim_client` (read), `dim_program_id` (read) |
| **Description** | Parses a NetSuite XLSM (wide format with "Data Entry" sheet or multi-sheet monthly tabs) or staging CSV (long format). Resolves FK columns (`account_id`, `client_id`, `master_program_id`, `program_id_key`) from dim tables. Applies sign convention (flips revenue accounts). Inserts into `stg_financials_raw` in batches of 500. |
| **MCP suitability** | Not recommended as MCP tool — requires local file path, performs destructive writes. |

**Exported types:** `NetSuiteUploadResult`

---

## Module: Upload (`upload-r1.ts`)

### `processR1Upload(filePath, userId, monthYear)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/upload-r1.ts` |
| **Params** | `filePath: string` — absolute path to R1 `.xlsx` file |
| | `userId: string` — user ID stamped on each row |
| | `monthYear: string` — target month in `YYYY-MM` format (stored as `YYYY-MM-01`) |
| **Returns** | `Promise<R1UploadResult>` — `{ sourceFileName, date, totalRowsRead, rowsSkipped, programGroupsFound, rowsInserted, warnings }` |
| **Tables** | `stg_financials_raw` (write/insert via REST), `dim_program_id` (read via REST), `dim_master_program` (read via REST) |
| **Description** | Parses an R1 XLSX file (columns: ProgramName, Master Program Name, TRGID, optional LocationID/RetailPrice). Aggregates rows by (masterProgram, programCode, location), counting distinct TRGIDs as "Checked-In Qty" (account_code="Checked-In Qty", account_id=130). Resolves FKs from dim tables via raw fetch (not Supabase client). Inserts in batches of 500. |
| **MCP suitability** | Not recommended — requires local file path, performs destructive writes. |

**Exported types:** `R1Row`, `R1UploadResult`

---

## Module: Upload (`upload-income.ts`)

### `uploadIncomeStatements(filePath, userId, periodOverride?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/upload-income.ts` |
| **Params** | `filePath: string` — absolute path to NetSuite income statement CSV |
| | `userId: string` — user ID (stored in `uploaded_by` if column exists) |
| | `periodOverride?: string` — optional YYYY-MM period override |
| **Returns** | `Promise<IncomeStatementResult>` — `{ period, monthLabel, upserted, skipped, warnings }` |
| **Tables** | `confirmed_income_statements` (write/upsert on `account_code,period`) |
| **Description** | Parses a NetSuite income statement CSV (month label on row 4, headers on row 7, data from row 9). Extracts 5-digit account codes from "XXXXX - Label" format. Parses currency strings like "$1,234.56" and "($1,234.56)". Upserts into `confirmed_income_statements` with conflict resolution on `(account_code, period)`. |
| **MCP suitability** | Not recommended — requires local file path, performs destructive writes. |

**Exported types:** `IncomeStatementResult`

---

## Module: Audit (`audit.ts`)

### `runAuditComparison(months?, tolerance?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/audit.ts` |
| **Params** | `months?: string[]` — optional YYYY-MM filter; if omitted, all months included |
| | `tolerance?: number` — dollar tolerance for match detection (default `$1.00`) |
| **Returns** | `Promise<AuditResult>` — `{ summaries: MonthSummary[], totalStagingRows, totalConfirmedRows }` |
| **Tables** | `stg_financials_raw` (read), `confirmed_income_statements` (read) |
| **Description** | Compares staged financials against confirmed income statements. Aggregates staging by `account_code|YYYY-MM`, then for each account in each month classifies as: exact match, sign-flip match, mismatch, confirmed-only, or staging-only. Computes accuracy percentage per month. |
| **MCP suitability** | **Excellent** — pure read-only query, returns structured comparison data. Safe to expose. |

**Exported types:** `MonthSummary`, `AuditResult`

**`MonthSummary` fields:** `month`, `confirmedAccounts`, `stagedAccounts`, `exactMatch`, `signFlipMatch`, `mismatch`, `confirmedOnly`, `stagingOnly`, `accuracy` (percentage or null), `stagedTotal`, `confirmedTotal`

---

## Module: Anomalies (`anomalies.ts`)

### `detectRateAnomalies(options?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/anomalies.ts` |
| **Params** | `options?: { months?: string[]; threshold?: number }` |
| | `months` — YYYY-MM strings to analyse; defaults to fiscal YTD (April start) |
| | `threshold` — z-score magnitude threshold (default `2.0`) |
| **Returns** | `Promise<AnomalyResult>` — `{ anomalies: RateAnomaly[], totalRows, threshold, months }` |
| **Tables** | `v_rate_anomaly_analysis` (read — Supabase view) |
| **Description** | Detects $/unit rate outliers across programs. Fetches from `v_rate_anomaly_analysis` view (paginated), computes per-month mean and stddev of `rate_per_unit`, flags programs where `|z-score| > threshold`. Results sorted by `|z-score|` descending. Each anomaly includes prior-month rate, delta percentages, and expected range. |
| **MCP suitability** | **Excellent** — pure read-only analytics query. Safe to expose. |

**Exported types:** `RateAnomaly`, `AnomalyResult`

**`RateAnomaly` fields:** `master_program`, `program_code`, `program_id`, `client_id`, `client_name`, `month`, `checkin_fee_dollars`, `units`, `rate_per_unit`, `prev_month_rate`, `rate_delta_pct`, `units_change_pct`, `dollars_change_pct`, `zscore`, `expected_range`

---

## Module: Diagnose (`diagnose.ts`)

### `diagnoseMonths(options?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/diagnose.ts` |
| **Params** | `options?: { months?: string[] }` — if omitted, all months in staging are analysed |
| **Returns** | `Promise<DiagnosisResult>` — `{ monthsAnalysed, totalRows, rowsPerMonth, medianRowCount, issues, summary }` |
| **Tables** | `stg_financials_raw` (read), `dim_account` (read), `dim_program_id` (read), `dim_master_program` (read), `dim_client` (read) |
| **Description** | Diagnoses FK resolution failures and data gaps. Checks: (1) null date/account_code rows, (2) account_codes missing from `dim_account`, (3) program_codes missing from `dim_program_id`, (4) orphaned program_codes (null `master_program_id`), (5) unresolved `master_program_id` values, (6) master programs without clients, (7) months with row count < 50% of median, (8) completely missing calendar months in the range. |
| **MCP suitability** | **Excellent** — pure read-only diagnostic. Safe to expose. |

**Exported types:** `DiagnosticIssueKind`, `DiagnosticIssue`, `DiagnosisResult`

**Issue kinds:** `unresolved_account_code`, `unresolved_program_code`, `unresolved_master_program`, `unresolved_client`, `low_row_count`, `missing_month`, `null_date_rows`, `null_account_code_rows`

---

## Module: KPIs (`kpis.ts`)

### `exportKpis(options?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/kpis.ts` |
| **Params** | `options?: ExportKpiOptions` |
| | `months?: string[]` — YYYY-MM months; defaults to 3 most recent |
| | `programs?: string[]` — program name substrings for case-insensitive partial match |
| **Returns** | `Promise<KpiRow[]>` — sorted by month, kpiName, clientName, programName |
| **Tables** | `stg_financials_raw` (read — for month discovery), `dim_master_program` (read), `dim_program_id` (read) |
| **RPC** | `get_kpi_totals_by_program_client(p_month, p_master_program_id?)` |
| **Description** | Exports KPI data aggregated by program/client/month. Resolves program name filters by searching both `dim_master_program.master_name` and `dim_program_id.program_code` for partial matches. Calls the `get_kpi_totals_by_program_client` RPC function per month (and per program if filtered). |
| **MCP suitability** | **Excellent** — pure read-only KPI export. Safe to expose. |

### `formatKpiTable(rows)`

| Field | Value |
|---|---|
| **Params** | `rows: KpiRow[]` |
| **Returns** | `string` — markdown table with compact amounts ($1.2M, $890K) |
| **Tables** | None (pure formatting) |
| **MCP suitability** | **Good** — pure formatter, useful as a helper in MCP tool responses. |

### `formatKpiCsv(rows)`

| Field | Value |
|---|---|
| **Params** | `rows: KpiRow[]` |
| **Returns** | `string` — CSV-formatted string |
| **Tables** | None (pure formatting) |
| **MCP suitability** | **Good** — pure formatter. |

**Exported types:** `KpiRow`, `ExportKpiOptions`

---

## Module: Templates (`templates.ts`)

### `generateNetSuiteTemplate(outputPath, options?)`

| Field | Value |
|---|---|
| **File** | `lib/returnpro/templates.ts` |
| **Params** | `outputPath: string` — destination file path for XLSX |
| | `options?: GenerateNetSuiteTemplateOptions` |
| | `fiscalYear?: string` — e.g. "FY2026" (metadata only) |
| | `month?: string` — "MMM YYYY" format, pre-fills date columns |
| **Returns** | `Promise<TemplateResult>` — `{ outputPath, accountCount, programCount, month }` |
| **Tables** | `dim_program_id` (read, filtered by `is_active=true`), `dim_account` (read) |
| **Description** | Generates a blank NetSuite upload template XLSX with 3 sheets: Data Entry (programs x account codes), Account Reference, and Instructions. Programs filtered to active only (`is_active=true`). |
| **MCP suitability** | Not ideal — produces a file on disk. Could be adapted if MCP supports file/blob responses. |

**Exported types:** `TemplateResult`, `GenerateNetSuiteTemplateOptions`

---

## Function-to-Table Matrix

| Function | `stg_financials_raw` | `confirmed_income_statements` | `dim_account` | `dim_client` | `dim_master_program` | `dim_program_id` | `v_rate_anomaly_analysis` | RPC |
|---|---|---|---|---|---|---|---|---|
| `processNetSuiteUpload` | **write** | | read | read | read | read | | |
| `processR1Upload` | **write** | | | | read | read | | |
| `uploadIncomeStatements` | | **upsert** | | | | | | |
| `runAuditComparison` | read | read | | | | | | |
| `detectRateAnomalies` | | | | | | | read | |
| `diagnoseMonths` | read | | read | read | read | read | | |
| `exportKpis` | read | | | | read | read | | `get_kpi_totals_by_program_client` |
| `formatKpiTable` | | | | | | | | |
| `formatKpiCsv` | | | | | | | | |
| `generateNetSuiteTemplate` | | | read | | | read | | |

---

## MCP Tool Recommendations

Functions recommended for MCP exposure (read-only, no file-system dependency, safe):

| MCP Tool Name | Function | Description |
|---|---|---|
| `returnpro_audit` | `runAuditComparison` | Compare staging vs confirmed income statements |
| `returnpro_anomalies` | `detectRateAnomalies` | Detect $/unit rate outliers via z-score analysis |
| `returnpro_diagnose` | `diagnoseMonths` | Diagnose FK failures, missing months, data gaps |
| `returnpro_kpis` | `exportKpis` | Export KPI data by program/client/month |
| `returnpro_format_kpis` | `formatKpiTable` | Format KPI rows as markdown table |

Functions **not** recommended for direct MCP exposure:

| Function | Reason |
|---|---|
| `processNetSuiteUpload` | Requires local file path; writes to staging table |
| `processR1Upload` | Requires local file path; writes to staging table |
| `uploadIncomeStatements` | Requires local file path; upserts confirmed data |
| `generateNetSuiteTemplate` | Writes XLSX file to disk |

---

## Data Model Notes

- `stg_financials_raw.amount` is stored as **TEXT**. All code must `parseFloat()` before arithmetic. This is a known source of bugs.
- Period format throughout the system is `YYYY-MM`.
- Fiscal year starts in April. KPIs and anomaly detection default to fiscal YTD when no months are specified.
- Sign convention: revenue accounts (`sign_multiplier = -1` in `dim_account`) have their amounts negated on upload.
- The `v_rate_anomaly_analysis` view pre-computes `rate_per_unit`, `prev_month_rate`, and various delta percentages.
- All Supabase queries use pagination (page size 1000) to bypass the PostgREST row cap.
