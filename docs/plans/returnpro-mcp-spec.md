# ReturnPro MCP Server — Integration Spec

**Version:** 1.0
**Date:** 2026-03-05
**Status:** Draft

## 1. Overview

The ReturnPro MCP (Model Context Protocol) server exposes ReturnPro financial data and operations to AI agents. It connects to the ReturnPro Supabase instance (`vvutttwunexshxkmygik.supabase.co`) and provides structured tools for querying financials, computing KPIs, detecting anomalies, diagnosing data quality issues, managing income statements, uploading financial data, and reviewing audit trails.

The server is designed for use by Claude and other MCP-compatible AI agents, giving them the ability to answer questions like:
- "What were Acme Corp's revenue numbers for Q3 2025?"
- "Are there any anomalous per-unit rates this month?"
- "Why did SG&A spike in October?"
- "What's the audit accuracy for the last 6 months?"

## 2. Authentication

| Variable | Description |
|----------|-------------|
| `RETURNPRO_SUPABASE_URL` | Supabase project URL (`https://vvutttwunexshxkmygik.supabase.co`) |
| `RETURNPRO_SUPABASE_SERVICE_KEY` | Service-role key for the ReturnPro instance |

The MCP server reads these from environment variables at startup. If either is missing, the server refuses to start. The service-role key grants full read/write access, so the MCP server enforces safety constraints at the tool layer (see Section 6).

The Supabase client is constructed using the same pattern as `lib/supabase.ts`:

```ts
import { createClient } from '@supabase/supabase-js'
const client = createClient(
  process.env.RETURNPRO_SUPABASE_URL!,
  process.env.RETURNPRO_SUPABASE_SERVICE_KEY!
)
```

## 3. Tools

### 3.1 `query_financials`

**Description:** Query raw staged financial data from `stg_financials_raw` with flexible filters. Returns rows matching the specified client, program, account, and/or period range.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "client_name": {
      "type": "string",
      "description": "Filter by client name (case-insensitive partial match via dim_client)"
    },
    "program": {
      "type": "string",
      "description": "Filter by master program name or program code (partial match)"
    },
    "account_code": {
      "type": "string",
      "description": "Filter by exact account code (e.g., '30010')"
    },
    "period_start": {
      "type": "string",
      "description": "Start of period range, inclusive. Format: YYYY-MM"
    },
    "period_end": {
      "type": "string",
      "description": "End of period range, inclusive. Format: YYYY-MM"
    },
    "limit": {
      "type": "number",
      "description": "Maximum rows to return. Default 500, max 5000."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "raw_id": { "type": "number" },
          "date": { "type": "string" },
          "account_code": { "type": "string" },
          "amount": { "type": "string", "description": "TEXT in DB; numeric string" },
          "master_program": { "type": "string" },
          "program_code": { "type": "string" },
          "location": { "type": "string" },
          "client_id": { "type": "number|null" },
          "master_program_id": { "type": "number|null" }
        }
      }
    },
    "total": { "type": "number", "description": "Total matching rows (may exceed limit)" },
    "truncated": { "type": "boolean" }
  }
}
```

**Implementation notes:**
- Queries `stg_financials_raw` with Supabase `.from().select().range()`.
- Period filtering: converts `period_start`/`period_end` to date ranges (e.g., `2025-01` becomes `gte.2025-01-01`).
- Client name filter resolves through `dim_client` to get `client_id`, then filters staging rows.
- Program filter resolves through `dim_master_program` and `dim_program_id` (same logic as `kpis.ts:resolveProgramIds`).
- Pagination: uses the same paginated fetch pattern as existing lib code (PAGE_SIZE=1000 chunks).
- `amount` is TEXT in the database -- the tool returns it as-is; agents should CAST to number for math.

---

### 3.2 `get_kpis`

**Description:** Get KPI metrics for a client/program/period, aggregated by program and client. Calls the `get_kpi_totals_by_program_client` Supabase RPC function.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "months": {
      "type": "array",
      "items": { "type": "string" },
      "description": "YYYY-MM months to query. Default: 3 most recent months with data."
    },
    "programs": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Program name substrings to filter by (case-insensitive partial match)"
    },
    "format": {
      "type": "string",
      "enum": ["json", "table", "csv"],
      "description": "Output format. Default: json"
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "month": { "type": "string" },
          "kpiName": { "type": "string" },
          "kpiBucket": { "type": "string" },
          "programName": { "type": "string" },
          "clientName": { "type": "string" },
          "totalAmount": { "type": "number" }
        }
      }
    },
    "formatted": {
      "type": "string",
      "description": "Pre-formatted output (markdown table or CSV) if format != json"
    },
    "count": { "type": "number" }
  }
}
```

**Implementation:** Wraps `lib/returnpro/kpis.ts:exportKpis()` and optionally `formatKpiTable()` / `formatKpiCsv()`.

---

### 3.3 `run_anomaly_detection`

**Description:** Detect anomalous per-unit rates across all programs. Flags programs where the $/unit rate is more than N standard deviations from the cross-sectional mean for that month.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "months": {
      "type": "array",
      "items": { "type": "string" },
      "description": "YYYY-MM months to analyse. Default: fiscal YTD (April to current month)."
    },
    "threshold": {
      "type": "number",
      "description": "Z-score threshold for flagging. Default: 2.0"
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "anomalies": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "master_program": { "type": "string" },
          "program_code": { "type": "string|null" },
          "client_name": { "type": "string|null" },
          "month": { "type": "string" },
          "checkin_fee_dollars": { "type": "number" },
          "units": { "type": "number" },
          "rate_per_unit": { "type": "number" },
          "prev_month_rate": { "type": "number|null" },
          "rate_delta_pct": { "type": "number|null" },
          "zscore": { "type": "number" },
          "expected_range": {
            "type": "array",
            "items": { "type": "number" },
            "minItems": 2,
            "maxItems": 2
          }
        }
      }
    },
    "totalRows": { "type": "number" },
    "threshold": { "type": "number" },
    "months": { "type": "array", "items": { "type": "string" } }
  }
}
```

**Implementation:** Wraps `lib/returnpro/anomalies.ts:detectRateAnomalies()`. The view `v_rate_anomaly_analysis` computes per-program-month rate_per_unit, prev_month_rate, and delta percentages. The function adds cross-sectional z-scores and filters by threshold.

---

### 3.4 `diagnose_variance`

**Description:** Diagnose data quality and FK resolution failures in `stg_financials_raw`. Checks for unresolved account codes, program codes, master programs, and clients; detects missing months and anomalously low row counts.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "months": {
      "type": "array",
      "items": { "type": "string" },
      "description": "YYYY-MM months to analyse. Default: all months present in staging."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "monthsAnalysed": { "type": "array", "items": { "type": "string" } },
    "totalRows": { "type": "number" },
    "rowsPerMonth": {
      "type": "object",
      "additionalProperties": { "type": "number" }
    },
    "medianRowCount": { "type": "number" },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "unresolved_account_code",
              "unresolved_program_code",
              "unresolved_master_program",
              "unresolved_client",
              "low_row_count",
              "missing_month",
              "null_date_rows",
              "null_account_code_rows"
            ]
          },
          "month": { "type": "string|null" },
          "message": { "type": "string" },
          "detail": { "type": "object" }
        }
      }
    },
    "summary": {
      "type": "object",
      "properties": {
        "unresolvedAccountCodes": { "type": "number" },
        "unresolvedProgramCodes": { "type": "number" },
        "unresolvedMasterPrograms": { "type": "number" },
        "unresolvedClients": { "type": "number" },
        "lowRowCountMonths": { "type": "number" },
        "missingMonths": { "type": "number" },
        "totalIssues": { "type": "number" }
      }
    }
  }
}
```

**Implementation:** Wraps `lib/returnpro/diagnose.ts:diagnoseMonths()`. Loads all staging rows, all four dimension tables (`dim_account`, `dim_program_id`, `dim_master_program`, `dim_client`), then cross-references FK resolution and row count statistics.

---

### 3.5 `get_income_statement`

**Description:** Query confirmed income statement data from `confirmed_income_statements`. Returns validated GL account balances by period.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "period": {
      "type": "string",
      "description": "YYYY-MM period to query (e.g., '2025-04')"
    },
    "account_code": {
      "type": "string",
      "description": "Filter by specific account code"
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "number" },
          "account_code": { "type": "string" },
          "netsuite_label": { "type": "string" },
          "period": { "type": "string" },
          "total_amount": { "type": "number" },
          "source": { "type": "string" },
          "updated_at": { "type": "string" }
        }
      }
    },
    "count": { "type": "number" }
  }
}
```

**Implementation:** Direct Supabase query on `confirmed_income_statements` with optional `.eq('period', period)` and `.eq('account_code', account_code)` filters.

---

### 3.6 `upload_financial_data`

**Description:** Ingest new financial records into `stg_financials_raw` with validation and FK resolution against dimension tables.

**Read-only:** No (WRITE)

**Confirmation required:** Yes -- the agent must present a summary of what will be inserted and receive explicit user confirmation before executing.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "records": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "master_program": { "type": "string", "description": "Master program name" },
          "program_code": { "type": "string", "description": "Program ID code" },
          "date": { "type": "string", "description": "ISO date YYYY-MM-DD" },
          "account_code": { "type": "string", "description": "Account code (e.g., '30010')" },
          "amount": { "type": "string", "description": "Amount as text (matches DB schema)" },
          "location": { "type": "string", "description": "Client/location name" },
          "mode": { "type": "string", "description": "Mode (e.g., 'Actual'). Default: 'Actual'" }
        },
        "required": ["master_program", "program_code", "date", "account_code", "amount"]
      },
      "description": "Array of financial records to insert"
    },
    "dry_run": {
      "type": "boolean",
      "description": "If true, validate and resolve FKs but do not insert. Default: false"
    },
    "source_label": {
      "type": "string",
      "description": "Label for source_file_name column. Default: 'mcp-upload'"
    }
  },
  "required": ["records"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "inserted": { "type": "number" },
    "skipped": { "type": "number" },
    "monthsCovered": { "type": "array", "items": { "type": "string" } },
    "warnings": { "type": "array", "items": { "type": "string" } },
    "dry_run": { "type": "boolean" },
    "validation": {
      "type": "object",
      "properties": {
        "resolvedAccounts": { "type": "number" },
        "unresolvedAccounts": { "type": "array", "items": { "type": "string" } },
        "resolvedPrograms": { "type": "number" },
        "unresolvedPrograms": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

**Implementation:** Follows the same FK resolution pattern as `lib/returnpro/upload-netsuite.ts`:
1. Validate all records (required fields, date format, non-empty amount).
2. Resolve FKs via `dim_account`, `dim_client`, `dim_master_program`, `dim_program_id`.
3. Apply sign convention (revenue accounts get `sign_multiplier = -1`).
4. If `dry_run`, return validation results without inserting.
5. Otherwise, insert in batches of 500 into `stg_financials_raw`.

---

### 3.7 `audit_trail`

**Description:** Compare staged financials against confirmed income statements to detect discrepancies. Returns per-month accuracy summaries showing exact matches, sign-flip matches, and mismatches.

**Read-only:** Yes

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "months": {
      "type": "array",
      "items": { "type": "string" },
      "description": "YYYY-MM months to audit. Default: all months with data."
    },
    "tolerance": {
      "type": "number",
      "description": "Dollar tolerance for match detection. Default: 1.00"
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "summaries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "month": { "type": "string" },
          "confirmedAccounts": { "type": "number" },
          "stagedAccounts": { "type": "number" },
          "exactMatch": { "type": "number" },
          "signFlipMatch": { "type": "number" },
          "mismatch": { "type": "number" },
          "confirmedOnly": { "type": "number" },
          "stagingOnly": { "type": "number" },
          "accuracy": { "type": "number|null", "description": "Percentage. null if no overlap." },
          "stagedTotal": { "type": "number" },
          "confirmedTotal": { "type": "number" }
        }
      }
    },
    "totalStagingRows": { "type": "number" },
    "totalConfirmedRows": { "type": "number" }
  }
}
```

**Implementation:** Wraps `lib/returnpro/audit.ts:runAuditComparison()`. Paginates both `stg_financials_raw` and `confirmed_income_statements`, aggregates staging by `account_code|YYYY-MM`, then compares with the confirmed data using dollar tolerance and sign-flip detection.

---

## 4. Resources (Read-Only)

MCP resources expose Supabase tables and views as read-only data sources that agents can browse without calling a tool.

| Resource URI | Source Table/View | Description |
|---|---|---|
| `returnpro://tables/stg_financials_raw` | `stg_financials_raw` | Raw staged financial data (amount is TEXT) |
| `returnpro://tables/confirmed_income_statements` | `confirmed_income_statements` | Confirmed GL account balances by period |
| `returnpro://tables/dim_account` | `dim_account` | Account code lookup (account_code, account_id, netsuite_label, sign_multiplier) |
| `returnpro://tables/dim_client` | `dim_client` | Client lookup (client_id, client_name) |
| `returnpro://tables/dim_master_program` | `dim_master_program` | Master program lookup (master_program_id, master_name, client_id) |
| `returnpro://tables/dim_program_id` | `dim_program_id` | Program ID lookup (program_id_key, program_code, master_program_id, is_active) |
| `returnpro://views/v_rate_anomaly_analysis` | `v_rate_anomaly_analysis` | Pre-computed per-program-month rate metrics with delta percentages |

Each resource returns paginated JSON (max 1000 rows per page). The MCP server handles pagination transparently using the same `range()` pattern used throughout `lib/returnpro/`.

## 5. Safety Model

### Read-Only Tools (safe to call without confirmation)
| Tool | Access Level |
|---|---|
| `query_financials` | Read |
| `get_kpis` | Read |
| `run_anomaly_detection` | Read |
| `diagnose_variance` | Read |
| `get_income_statement` | Read |
| `audit_trail` | Read |

### Write Tools (require confirmation)
| Tool | Access Level | Confirmation Required |
|---|---|---|
| `upload_financial_data` | Write | Yes -- must show summary to user before executing |

### Write Safety Rules

1. **Dry-run first:** When `upload_financial_data` is called, the agent SHOULD first call it with `dry_run: true` to validate and show the user what would be inserted.
2. **Explicit confirmation:** The agent MUST obtain explicit user confirmation before calling `upload_financial_data` with `dry_run: false`.
3. **No deletes:** The MCP server does NOT expose any delete operations. Rows in `stg_financials_raw` can only be added, never removed via MCP.
4. **No schema changes:** The MCP server cannot modify table schemas, create/drop tables, or run arbitrary SQL.
5. **Audit logging:** Every `upload_financial_data` call (including dry runs) is logged with timestamp, source label, and row count.
6. **Rate limiting:** The server enforces a maximum of 5000 rows per `upload_financial_data` call to prevent accidental bulk inserts.

## 6. Error Handling

All tools return errors in a consistent format:

```json
{
  "error": {
    "code": "INVALID_PERIOD_FORMAT",
    "message": "Period must be in YYYY-MM format, got: '2025'"
  }
}
```

Error codes:
| Code | Description |
|---|---|
| `MISSING_AUTH` | `RETURNPRO_SUPABASE_SERVICE_KEY` not set |
| `INVALID_PERIOD_FORMAT` | Period string not in YYYY-MM format |
| `INVALID_DATE_FORMAT` | Date string not in YYYY-MM-DD format |
| `QUERY_FAILED` | Supabase query returned an error |
| `VALIDATION_FAILED` | Input records failed validation |
| `TOO_MANY_ROWS` | Upload exceeds 5000-row limit |
| `FK_RESOLUTION_FAILED` | Critical FK lookups failed (all records unresolvable) |
| `CONFIRMATION_REQUIRED` | Write operation attempted without user confirmation |

## 7. Implementation Plan

### Phase 1: Core MCP Server Skeleton
- Set up MCP server using `@modelcontextprotocol/sdk`
- Implement auth from env vars
- Register all 7 tools with input validation

### Phase 2: Read-Only Tools
- Wire `query_financials`, `get_kpis`, `run_anomaly_detection`, `diagnose_variance`, `get_income_statement`, `audit_trail`
- Reuse existing `lib/returnpro/` functions directly
- Add resource handlers for dimension tables

### Phase 3: Write Tools
- Implement `upload_financial_data` with dry-run support
- Add confirmation flow
- Add rate limiting and audit logging

### Phase 4: Testing
- Test with demo dataset (see `scripts/seed-returnpro-demo.ts`)
- Validate all tool schemas against MCP spec
- End-to-end test with Claude Desktop
