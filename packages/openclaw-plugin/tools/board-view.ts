import { Type, type Static } from '@sinclair/typebox'

import type { BoardOps } from '../lib/board-ops.js'
import type { TaskStatus, TaskType } from '../lib/types.js'

const TaskStatusEnum = Type.Union(
  [
    Type.Literal('backlog'),
    Type.Literal('ready'),
    Type.Literal('claimed'),
    Type.Literal('in_progress'),
    Type.Literal('review'),
    Type.Literal('done'),
    Type.Literal('blocked'),
  ],
  { description: 'Task status to filter by.' },
)

const TaskTypeEnum = Type.Union(
  [Type.Literal('epic'), Type.Literal('story'), Type.Literal('task')],
  { description: 'Task type to filter by (epic | story | task).' },
)

export const BoardViewParams = Type.Object({
  project_id: Type.Optional(
    Type.String({ description: 'Project UUID to scope results to.' }),
  ),
  status: Type.Optional(TaskStatusEnum),
  statuses: Type.Optional(
    Type.Array(TaskStatusEnum, {
      description: 'Multiple statuses to include (overrides single status).',
    }),
  ),
  claimed_by: Type.Optional(
    Type.String({ description: 'Filter to tasks claimed by this agent.' }),
  ),
  assigned_to: Type.Optional(
    Type.String({ description: 'Filter to tasks assigned to this agent.' }),
  ),
  task_type: Type.Optional(TaskTypeEnum),
  parent_id: Type.Optional(
    Type.String({
      description: 'Filter to children of this parent task. Pass an empty string for root.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      default: 50,
      description: 'Maximum tasks to return (default 50, max 200).',
    }),
  ),
})

export type BoardViewArgs = Static<typeof BoardViewParams>

export function createBoardViewTool(board: BoardOps) {
  return {
    name: 'board_view',
    label: 'Board View',
    description:
      'List kanban tasks from the OptimalOS board with optional filters (project, status, agent, type). ' +
      'Returns lightweight rows suitable for triage. Use board_view first before claim/update/complete.',
    parameters: BoardViewParams,
    async execute(_toolCallId: string, args: BoardViewArgs) {
      const tasks = await board.listTasks({
        project_id: args.project_id,
        status: args.status as TaskStatus | undefined,
        statuses: args.statuses as TaskStatus[] | undefined,
        claimed_by: args.claimed_by,
        assigned_to: args.assigned_to,
        task_type: args.task_type as TaskType | undefined,
        parent_id: args.parent_id === '' ? null : args.parent_id,
        limit: args.limit ?? 50,
      })

      const rows = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        task_type: t.task_type,
        parent_id: t.parent_id,
        claimed_by: t.claimed_by,
        assigned_to: t.assigned_to,
        skill_required: t.skill_required,
        estimated_effort: t.estimated_effort,
        blocked_by: t.blocked_by,
        updated_at: t.updated_at,
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ count: rows.length, tasks: rows }, null, 2),
          },
        ],
        details: { count: rows.length, tasks: rows },
      }
    },
  }
}
