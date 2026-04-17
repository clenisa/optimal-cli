-- Add task hierarchy: epics contain stories, stories contain tasks
-- Only leaf tasks (task_type='task') are claimable by agents
-- Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tasks' AND column_name = 'task_type') THEN
    ALTER TABLE tasks ADD COLUMN task_type text NOT NULL DEFAULT 'task'
      CHECK (task_type IN ('epic', 'story', 'task'));
  END IF;
END $$;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
