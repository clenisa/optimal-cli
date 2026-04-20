import { Type, type Static } from '@sinclair/typebox'

import type { BoardOps } from '../lib/board-ops.js'

export const BoardClaimParams = Type.Object({
  task_id: Type.String({ description: 'UUID of the task to claim.' }),
  agent: Type.String({
    minLength: 1,
    description: 'Agent identifier taking ownership (e.g., "openclaw-coding", "claude-opus").',
  }),
})

export type BoardClaimArgs = Static<typeof BoardClaimParams>

export function createBoardClaimTool(board: BoardOps) {
  return {
    name: 'board_claim',
    label: 'Board Claim',
    description:
      'Claim a leaf task for an agent. Sets status=claimed, claimed_by, claimed_at and writes a ' +
      'status_changed activity entry. Refuses if the task is an epic/story or already claimed by another agent.',
    parameters: BoardClaimParams,
    async execute(_toolCallId: string, args: BoardClaimArgs) {
      const task = await board.claimTask(args.task_id, args.agent)
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
                  claimed_by: task.claimed_by,
                  claimed_at: task.claimed_at,
                },
                message: `Claimed ${task.id} for ${args.agent}.`,
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
