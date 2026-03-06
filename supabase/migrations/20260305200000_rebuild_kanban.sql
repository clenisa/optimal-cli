-- Drop old tables
DROP TABLE IF EXISTS cli_task_logs CASCADE;
DROP TABLE IF EXISTS cli_tasks CASCADE;
DROP TABLE IF EXISTS cli_projects CASCADE;

-- Projects
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','archived')),
  owner text,
  priority int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Milestones
CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  due_date date,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','missed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Labels
CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tasks
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog','ready','claimed','in_progress','review','done','blocked')),
  priority int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  assigned_to text,
  claimed_by text,
  claimed_at timestamptz,
  skill_required text,
  source_repo text,
  target_module text,
  estimated_effort text CHECK (estimated_effort IN ('xs','s','m','l','xl')),
  blocked_by uuid[] DEFAULT '{}',
  sort_order int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Task-Label join
CREATE TABLE task_labels (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

-- Comments
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  comment_type text NOT NULL DEFAULT 'comment'
    CHECK (comment_type IN ('comment','status_change','claim','review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Activity log
CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_claimed ON tasks(claimed_by);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_priority ON tasks(priority, sort_order);
CREATE INDEX idx_comments_task ON comments(task_id);
CREATE INDEX idx_activity_task ON activity_log(task_id);
CREATE INDEX idx_activity_actor ON activity_log(actor);
CREATE INDEX idx_milestones_project ON milestones(project_id);

-- updated_at triggers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_milestones_updated BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: service_role full access
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON projects FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON milestones FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON labels FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON task_labels FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON comments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON activity_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Read-only access for anon (dashboard)
CREATE POLICY "anon_read" ON projects FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON milestones FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON labels FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON tasks FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON task_labels FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON comments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON activity_log FOR SELECT TO anon USING (true);
