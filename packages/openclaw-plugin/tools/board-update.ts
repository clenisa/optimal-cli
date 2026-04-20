import { Type, type Static } from '@sinclair/typebox'

import type { BoardOps } from '../lib/board-ops.js'
import type { Task, TaskStatus } from '../lib/types.js'

const TaskStatusEnum = Type.Union([
  Type.Literal('backlog'),
  Type.Literal('ready'),
  Type.Literal('claimed'),
  Type.Literal('in_progress'),
  Type.Literal('review'),
  Type.Literal('done'),
  Type.Literal('blocked'),
])

export const BoardUpdateParams = Type.Object({
  task_id: Type.String({ description: 'UUID of the task to update.' }),
  actor: Type.String({
    minLength: 1,
    description: 'Agent / user making the change (recorded on activity_log).',
  }),
  status: Type.Optional(TaskStatusEnum),
  title: Type.Optional(Type.String({ description: 'New title for the task.' })),
  description: Type.Optional(Type.String({ description: 'New description body.' })),
  priority: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 4, description: 'Priority 1–4.' }),
  ),
  assigned_to: Type.Optional(
    Type.String({
      description: "Push assignment to an agent. Pass empty string to clear.",
    }),
  ),
  claimed_by: Type.Optional(
    Type.String({
      description: 'Override claim ownership. Pass empty string to release.',
    }),
  ),
  estimated_effort: Type.Optional(
    Type.Union([
      Type.Literal('xs'),
      Type.Literal('s'),
      Type.Literal('m'),
      Type.Literal('l'),
      Type.Literal('xl'),
    ]),
  ),
})

export type BoardUpdateArgs = Static<typeof BoardUpdateParams>

export function createBoardUpdateTool(board: BoardOps) {
  return {
    name: 'board_update',
    label: 'Board Update',
    description:
      'Update fields on an existing task (status, title, description, priority, assignment, effort). ' +
      'Writes an "updated" or "status_changed" entry to activity_log. Use board_complete for done transitions.',
    parameters: BoardUpdateParams,
    async execute(_toolCallId: string, args: BoardUpdateArgs) {
      const updates: Partial<Task> = {}
      if (args.status !== undefined) updates.status = args.status as TaskStatus
      if (args.title !== undefined) updates.title = args.title
      if (args.description !== undefined) updates.description = args.description
      if (args.priority !== undefined) {
        updates.priority = args.priority as Task['priority']
      }
      if (args.assigned_to !== undefined) {
        updates.assigned_to = args.assigned_to === '' ? null : args.assigned_to
      }
      if (args.claimed_by !== undefined) {
        updates.claimed_by = args.claimed_by === '' ? null : args.claimed_by
        if (args.claimed_by === '') updates.claimed_at = null
      }
      if (args.estimated_effort !== undefined) {
        updates.estimated_effort = args.estimated_effort
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('board_update requires at least one mutable field beyond task_id/actor.')
      }

      const task = await board.updateTask(args.task_id, updates, args.actor)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                task: {
                  id: task.id,
                  title: task.title,
                  status: task.status,
                  priority: task.priority,
                  claimed_by: task.claimed_by,
                  assigned_to: task.assigned_to,
                  estimated_effort: task.estimated_effort,
                },
                message: `Updated ${task.id}.`,
              },
              null,
              2,
            ),
          },
        ],
        details: { task },
      }
    },
  }
}
