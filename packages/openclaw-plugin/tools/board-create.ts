import { Type, type Static } from '@sinclair/typebox'

import type { BoardOps } from '../lib/board-ops.js'
import type { TaskType } from '../lib/types.js'

export const BoardCreateParams = Type.Object({
  project_id: Type.String({
    description: 'UUID of the project this task belongs to.',
  }),
  title: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'Short task title (1–200 chars).',
  }),
  description: Type.Optional(
    Type.String({ description: 'Markdown body / acceptance criteria.' }),
  ),
  priority: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 4,
      default: 3,
      description: 'Priority 1 (highest) → 4 (lowest). Defaults to 3.',
    }),
  ),
  task_type: Type.Optional(
    Type.Union([Type.Literal('epic'), Type.Literal('story'), Type.Literal('task')], {
      default: 'task',
      description: 'Task type. Stories require parent_id (epic UUID).',
    }),
  ),
  parent_id: Type.Optional(
    Type.String({ description: 'Parent epic/story UUID. Required for stories.' }),
  ),
  skill_required: Type.Optional(
    Type.String({
      description: "Skill identifier the agent must have (e.g., 'typescript', 'sql').",
    }),
  ),
  estimated_effort: Type.Optional(
    Type.Union(
      [
        Type.Literal('xs'),
        Type.Literal('s'),
        Type.Literal('m'),
        Type.Literal('l'),
        Type.Literal('xl'),
      ],
      { description: 'T-shirt size estimate.' },
    ),
  ),
  actor: Type.Optional(
    Type.String({
      description: 'Agent / user creating the task. Falls back to plugin defaultActor.',
    }),
  ),
})

export type BoardCreateArgs = Static<typeof BoardCreateParams>

export function createBoardCreateTool(board: BoardOps) {
  return {
    name: 'board_create',
    label: 'Board Create',
    description:
      'Create a new kanban task on the OptimalOS board. Returns the new task UUID. ' +
      'Stories must include parent_id pointing at an epic. Logs a "created" entry to activity_log.',
    parameters: BoardCreateParams,
    async execute(_toolCallId: string, args: BoardCreateArgs) {
      const task = await board.createTask({
        project_id: args.project_id,
        title: args.title,
        description: args.description,
        priority: args.priority,
        task_type: args.task_type as TaskType | undefined,
        parent_id: args.parent_id,
        skill_required: args.skill_required,
        estimated_effort: args.estimated_effort,
        actor: args.actor,
      })

      const summary = `Created ${task.task_type} ${task.id} — "${task.title}"`
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
                  task_type: task.task_type,
                  status: task.status,
                  project_id: task.project_id,
                  parent_id: task.parent_id,
                },
                message: summary,
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
