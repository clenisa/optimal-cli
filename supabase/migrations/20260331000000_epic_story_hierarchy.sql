-- Add task hierarchy: epics contain stories, stories contain tasks
-- Only leaf tasks (task_type='task') are claimable by agents

ALTER TABLE tasks ADD COLUMN task_type text NOT NULL DEFAULT 'task'
  CHECK (task_type IN ('epic', 'story', 'task'));

ALTER TABLE tasks ADD COLUMN parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_type ON tasks(task_type);
