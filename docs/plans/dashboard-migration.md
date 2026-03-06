# Dashboard Migration Plan

## 1. ReturnPro Dashboard (dashboard-returnpro)

### Overview
Full-stack Next.js 16 financial dashboard for ReturnPro. Used by Carlos (admin), Wes (account exec), Dana (viewer), and Bolivar (operations lead). Handles financial data ingestion, KPI exploration, FP&A budgeting, yield/operations modeling, bank reconciliation, and R1 volume processing.

### Framework & Stack
- **Framework**: Next.js 16 (App Router, Turbopack)
- **UI**: Tailwind CSS + shadcn/ui + Radix primitives + Recharts
- **Backend**: Supabase (ReturnPro instance: vvutttwunexshxkmygik.supabase.co)
- **Auth**: Custom auth with password validation, lockout, audit logging
- **Special**: Rust/WASM parser (calamine) for R1 XLSX files via Web Worker
- **Package Manager**: pnpm

### Key Pages

| Route | Purpose | Data Source |
|-------|---------|-------------|
| `/home` | KPI Explorer, Income Statement, Rate Anomaly tabs | `stg_financials_raw`, `confirmed_income_statements`, `dim_*` |
| `/fpa/budgets` | Account Management - projection matrix, R1 batch upload | `fpa_wes_imports`, `fpa_budget_projections`, `fpa_annual_overrides`, `dim_master_program` |
| `/fpa/yields` | Operations/Yield model - WIP, production %, yield % | `fpa_yield_assumptions`, `fpa_wes_imports`, `dim_location`, `dim_client` |
| `/data-audit` | Month-over-month data audit matrix | `stg_financials_raw`, `confirmed_income_statements` |
| `/r1-processing` | R1 volume processor (WASM), Master P&L generator | Client-side XLSX parsing, then `fpa_wes_imports` |
| `/reconciliation` | Bank reconciliation, Walmart Canada JE tool | Client-side XLSX + NetSuite data |
| `/admin` | User management, audit logs | `user_profiles`, `audit_logs` |
| `/brton-wizard` | BRTON internal tool | Various dim tables |
| `/login`, `/change-password` | Auth pages | `user_profiles` |

### Supabase Tables Queried (ReturnPro Instance)

**FP&A / Budget:**
- `fpa_wes_imports` - R1 volume imports per user/month/program
- `fpa_budget_projections` - Saved projection overrides
- `fpa_annual_overrides` - Annual-level overrides
- `fpa_yield_assumptions` - WIP/yield/production percentages
- `fpa_unreconciled_imports` - Unmatched import rows
- `fpa_program_mappings` - Program code to master program mappings

**Dimension Tables:**
- `dim_master_program` - Master program lookup (source: netsuite/fpa/legacy)
- `dim_program_id` - Program ID lookup
- `dim_client` - Client name/ID
- `dim_location` - Location/building lookup
- `dim_account` - Account codes with sign_multiplier
- `dim_kpi` - KPI definitions

**Financial:**
- `stg_financials_raw` - Staged financial data (amount is TEXT)
- `confirmed_income_statements` - Confirmed GL accounts

**Auth/Admin:**
- `user_profiles` - User accounts, roles, lockout state
- `audit_logs` - Audit trail

### Dependencies (key ones)
- next 16.1.6, react 19.2.0
- @supabase/ssr, @supabase/supabase-js
- recharts (charting)
- @tanstack/react-table (data grids)
- exceljs, xlsx (spreadsheet I/O)
- wasm-pack output (R1 parsing)
- 20+ @radix-ui packages (via shadcn/ui)
- date-fns, zod, react-hook-form

### Core Functionality
1. **KPI Explorer** - Multi-dimensional financial KPI drill-down with client/master-program/program filters
2. **Account Management** - Budget projection matrix with multi-user scenarios, R1 data upload, code-level overrides
3. **Operations Model** - Vena-style yield/WIP tracking with month-by-month rollover
4. **R1 Processing** - WASM-based R1 XLSX parser for checked-in/sold volume counting
5. **Reconciliation** - Bank statement matching and Walmart Canada journal entries
6. **Data Audit** - Cross-month data completeness verification

---

## 2. Wes Dashboard (wes-dashboard)

### Overview
Lightweight client-side budget projection tool. Originally built on Lovable.dev for Wes (Account Manager Executive) to forecast 2026 checked-in unit volumes by master program. No backend -- all data stays in browser localStorage.

### Framework & Stack
- **Framework**: Vite + React 18 + TypeScript
- **UI**: Tailwind CSS 3 + shadcn/ui
- **Charts**: Recharts
- **XLSX Parsing**: SheetJS (xlsx)
- **Routing**: react-router-dom
- **State**: React Query + localStorage
- **Backend**: None (fully client-side)

### Key Components

| Component | Purpose |
|-----------|---------|
| `CheckedInUploader` | Upload R1 XLSX, parse checked-in units by master program |
| `ProjectionMatrix` | Main budgeting tool: % or flat adjustments per program, grouped by client > master program |
| `AnnualSummaryPage` | Rolled-up annual view with charts, building breakdown, trend lines |
| `BuildingView` | Units by building/location |
| `TrendLineChart` | Multi-month trend visualization with client/program filters |
| `SavedBudgetsPanel` | Load/save budgets from localStorage |
| `CustomProgramModal` | Add custom new-business programs |
| `ExportDataButton` | Export projections to XLSX |
| `DocumentUploader` | Generic document upload |

### Supabase Tables (currently none -- hardcoded dims)
The wes-dashboard currently uses hardcoded dimension data extracted from ReturnPro on 2026-01-15:
- `src/data/dims/masterPrograms.ts` - mirrors `dim_master_program`
- `src/data/dims/clients.ts` - mirrors `dim_client`
- `src/data/dims/locations.ts` - mirrors `dim_location`

**For the monorepo stub**, we will connect to the ReturnPro Supabase instance and query:
- `fpa_wes_imports` - actual volume data
- `fpa_budget_projections` - saved projections
- `dim_master_program` - program lookup
- `dim_client` - client lookup

### Dependencies (key ones)
- react 18.3.1, react-dom 18.3.1
- @supabase/supabase-js (listed but unused)
- recharts (charting)
- xlsx (SheetJS)
- react-router-dom
- @tanstack/react-query
- date-fns, zod, react-hook-form
- 20+ @radix-ui packages

### Core Functionality
1. **R1 Upload** - Parse R1 checked-in XLSX, count TRGIDs (or LocationIDs for pallet programs)
2. **Projection Matrix** - Apply % or flat adjustments to 2025 actuals for 2026 budgeting
3. **Annual Summary** - Rolled-up view with bar/pie charts, building breakdowns
4. **Budget Persistence** - Save/load budgets via localStorage
5. **Custom Programs** - Add new-business programs not yet in dimension tables

---

## 3. Migration Plan

### Strategy
Both dashboards get **lightweight stubs** in `apps/` now. Full implementation is deferred -- the stubs prove the pattern works (Next.js server component querying Supabase) and reserve the namespace.

### What to Keep
- **ReturnPro Dashboard**: The FP&A pages (`/fpa/budgets`, `/fpa/yields`) are the highest-value features. The KPI Explorer and data audit are secondary. Auth, admin, and reconciliation can be simplified or dropped.
- **Wes Dashboard**: The ProjectionMatrix is the core feature. Replace localStorage with Supabase queries. Drop the XLSX upload (ReturnPro dashboard handles that now).

### What to Simplify
- Both stubs start as **read-only server components** (matching the monorepo pattern in `apps/board`)
- No auth layer in stubs -- the monorepo apps are internal tools
- No shadcn/ui or Radix in stubs -- plain Tailwind only
- No recharts in stubs -- text/table-based display
- WASM parser excluded entirely -- ReturnPro handles R1 uploads

### Stub Scope (Phase 1 -- now)
- `apps/returnpro-dashboard/`: Query ReturnPro Supabase for high-level financial metrics (total revenue, unit counts, program count). Single page.tsx.
- `apps/wes-dashboard/`: Query ReturnPro Supabase for budget projection summary (total projected units by user). Single page.tsx.

### Full Port Scope (Phase 2 -- future)

**returnpro-dashboard estimated effort: 3-4 weeks**
- Port KPI Explorer (1 week)
- Port FP&A Budget/Yields pages (1.5 weeks)
- Port data audit + reconciliation (0.5 week)
- Auth + admin (0.5 week)
- WASM R1 parser integration (optional, keep in original repo)

**wes-dashboard estimated effort: 1-1.5 weeks**
- Port ProjectionMatrix with Supabase backend (3 days)
- Port AnnualSummary with server-side data (2 days)
- Port export functionality (1 day)
- Drop localStorage, use Supabase for persistence (1 day)

### Environment Variables Needed
Both stubs use the ReturnPro Supabase instance:
```
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=<service role key>
```
