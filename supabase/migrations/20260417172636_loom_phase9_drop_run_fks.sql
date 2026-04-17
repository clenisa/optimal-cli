-- Migration: loom_phase9_drop_run_fks
-- Target: optimalos
-- Created: 2026-04-17T17:26:36.145Z

-- Loom Phase 9 MVP: drop loom_runs FK from loom_step_runs and loom_job_queue.
-- Rationale: the runner on each dispatching node writes loom_runs to local
-- SQLite only. Cross-node steps write to the Supabase copies of
-- loom_step_runs / loom_job_queue, but there is no matching loom_runs row
-- remotely, so the FK rejects the write. Until (if ever) we mirror
-- loom_runs to Supabase as well, these FKs must go.

ALTER TABLE loom_step_runs DROP CONSTRAINT IF EXISTS loom_step_runs_run_id_fkey;
ALTER TABLE loom_job_queue DROP CONSTRAINT IF EXISTS loom_job_queue_run_id_fkey;

-- Unblock workflow_id FKs too in case step_runs/job_queue reference a
-- workflow that exists only on the node that owns it.
ALTER TABLE loom_runs DROP CONSTRAINT IF EXISTS loom_runs_workflow_id_fkey;
ALTER TABLE loom_workflow_steps DROP CONSTRAINT IF EXISTS loom_workflow_steps_workflow_id_fkey;
