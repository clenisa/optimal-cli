/**
 * `optimal morning` — terminal view of the latest priority-triage run.
 *
 * Hits `/api/morning` on the fabric cloud (or any OptimalOS instance):
 *   - default URL: process.env.OPTIMAL_FABRIC_URL ?? https://fabric.optimal.miami
 *   - auth:        process.env.OPTIMAL_PASSPHRASE (or --passphrase)
 *
 * Output mirrors the cockpit "Morning" widget — Bloomberg-dense, mono
 * columns, score-coded left-border via colored severity glyph.
 *
 *   MORNING                                              [run #42 · 12m ago]
 *   NOW 3 │ NEXT 7 │ LATER 21 │ 84 BACKLOG
 *   ────────────────────────────────────────────────────────────────────
 *   ▌ Pi systemctl restart                                       0.92
 *   ▌ Hetzner claude /login                                      0.88
 *   ▌ First vault entry                                          0.84
 *
 * With `--rerun`, fires `/api/triage/rerun` first and polls until the
 * latest_run.id advances (or 3 min elapses), then renders.
 */

import { colorize } from "../format.js";

interface MorningTask {
  id: string;
  title: string;
  current_score: number | null;
  current_rank: number | null;
  reasoning?: string | null;
}

interface MorningPayload {
  now: MorningTask[];
  next: MorningTask[];
  latest_run: {
    id: number;
    status: string;
    completed_at: string | null;
  } | null;
  unconsumed_briefs: number;
  counts: { now: number; next: number; later: number; backlog: number };
}

export interface MorningOptions {
  url: string;
  passphrase: string;
  rerun?: boolean;
}

async function authenticate(opts: MorningOptions): Promise<string> {
  const res = await fetch(`${opts.url}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: opts.passphrase }),
  });
  if (!res.ok) {
    throw new Error(
      `auth failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error("auth response missing token");
  return token;
}

async function fetchMorning(
  opts: MorningOptions,
  token: string,
): Promise<MorningPayload> {
  const res = await fetch(`${opts.url}/api/morning`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `/api/morning HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  return (await res.json()) as MorningPayload;
}

async function triggerRerun(opts: MorningOptions, token: string): Promise<void> {
  const startSnapshot = await fetchMorning(opts, token);
  const startRunId = startSnapshot.latest_run?.id ?? 0;

  const res = await fetch(`${opts.url}/api/triage/rerun`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(
      `/api/triage/rerun HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  process.stdout.write(colorize("⋯ ", "dim") + "scoring tasks ");

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    process.stdout.write(".");
    const snap = await fetchMorning(opts, token).catch(() => null);
    if (snap?.latest_run && snap.latest_run.id !== startRunId) {
      process.stdout.write(" " + colorize("done", "green") + "\n\n");
      return;
    }
  }
  process.stdout.write(" " + colorize("timeout", "yellow") + "\n\n");
}

// ── Render ────────────────────────────────────────────────────────────

function scoreColor(score: number): "red" | "yellow" | "dim" {
  if (score >= 0.8) return "red"; // urgent — pull focus
  if (score >= 0.6) return "yellow"; // noticeable
  return "dim";
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderMorning(data: MorningPayload): void {
  const COLS = 72;
  const rule = "─".repeat(COLS);

  // Header line: "MORNING" + run metadata right-aligned.
  let runMeta = "";
  if (data.latest_run) {
    const when = data.latest_run.completed_at
      ? timeAgo(data.latest_run.completed_at)
      : data.latest_run.status;
    runMeta = `run #${data.latest_run.id} · ${when}`;
    if (data.unconsumed_briefs > 0) {
      runMeta += ` · ${data.unconsumed_briefs} new brief(s)`;
    }
  } else {
    runMeta = colorize("no triage yet — use --rerun", "yellow");
  }
  const header =
    colorize("MORNING", "bold") +
    " ".repeat(Math.max(1, COLS - "MORNING".length - runMeta.length)) +
    colorize(runMeta, "dim");
  console.log(header);

  // Counts row. Older cloud bundles (pre-2026-05-12) don't return `counts`;
  // fall back to derived numbers from the now/next arrays so the CLI still
  // renders something useful.
  const c = data.counts ?? {
    now: data.now?.length ?? 0,
    next: data.next?.length ?? 0,
    later: 0,
    backlog: 0,
  };
  const countsLine = [
    `${colorize("NOW", "red")}  ${c.now.toString().padStart(2)}`,
    `${colorize("NEXT", "yellow")}  ${c.next.toString().padStart(2)}`,
    `${colorize("LATER", "dim")} ${c.later.toString().padStart(3)}`,
    `${colorize("BACKLOG", "dim")} ${c.backlog.toString().padStart(4)}`,
  ].join(" │ ");
  console.log(countsLine);
  console.log(colorize(rule, "dim"));

  // NOW items.
  if (data.now.length === 0) {
    console.log(
      colorize(
        data.latest_run
          ? "  no NOW tasks — clear runway"
          : "  press [↻] in cockpit or run with --rerun to score",
        "dim",
      ),
    );
    return;
  }

  for (const task of data.now.slice(0, 5)) {
    const score = task.current_score ?? 0;
    const marker = colorize("▌", scoreColor(score));
    const titleWidth = COLS - 4 - 6; // marker + space + score column
    const title = task.title.length > titleWidth
      ? task.title.slice(0, titleWidth - 1) + "…"
      : task.title.padEnd(titleWidth);
    const scoreStr = colorize(score.toFixed(2).padStart(4), scoreColor(score));
    console.log(`${marker} ${title} ${scoreStr}`);
    if (task.reasoning) {
      const r =
        task.reasoning.length > COLS - 4
          ? task.reasoning.slice(0, COLS - 5) + "…"
          : task.reasoning;
      console.log("  " + colorize(r, "dim"));
    }
  }
}

// ── Public entry ──────────────────────────────────────────────────────

export async function morningCommand(opts: MorningOptions): Promise<void> {
  if (!opts.passphrase) {
    throw new Error(
      "Set OPTIMAL_PASSPHRASE env var or pass --passphrase to authenticate",
    );
  }
  const token = await authenticate(opts);

  if (opts.rerun) {
    await triggerRerun(opts, token);
  }

  const data = await fetchMorning(opts, token);
  renderMorning(data);
}
