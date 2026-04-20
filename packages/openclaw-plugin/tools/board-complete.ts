import { Type, type Static } from '@sinclair/typebox'

import type { BoardOps } from '../lib/board-ops.js'

export const BoardCompleteParams = Type.Object({
  task_id: Type.String({ description: 'UUID of the task to mark complete.' }),
  actor: Type.String({
    minLength: 1,
    description: 'Agent / user completing the task (logged to activity_log).',
  }),
  summary: Type.Optional(
    Type.String({
      description: 'Optional one-line summary of what was delivered (recorded on activity_log).',
    }),
  ),
})

export type BoardCompleteArgs = Static<typeof BoardCompleteParams>

export function createBoardCompleteTool(board: BoardOps) {
  return {
    name: 'board_complete',
    label: 'Board Complete',
    description:
      'Mark a task as done (status=done, completed_at=now). Optional summary is recorded ' +
      'on the activity_log entry. Triggers parent epic/story status cascade in the optimal-cli runtime.',
    parameters: BoardCompleteParams,
    async execute(_toolCallId: string, args: BoardCompleteArgs) {
      const task = await board.completeTask(args.task_id, args.actor)
      if (args.summary) {
        await board.logActivity({
          task_id: task.id,
          project_id: task.project_id,
          actor: args.actor,
          action: 'completed_summary',
          new_value: { summary: args.summary },
        })
      }
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
                  completed_at: task.completed_at,
                },
                message: `Marked ${task.id} as done.`,
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
