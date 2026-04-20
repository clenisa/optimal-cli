import { getTask, listChildren } from './index.js'
import type { Task, TaskStatus } from './types.js'

export interface BuildPromptOptions {
  /** Override working directory instead of deriving from source_repo */
  workingDirectory?: string
  /** Extra instructions to append */
  extraInstructions?: string
}

import { getRepoPath } from '../infra/repo-paths.js'

const HOME = process.env.OPTIMAL_REPOS_ROOT || process.env.HOME || '/home/oracle'

/**
 * Map a source_repo name to its working directory on the Pi.
 *
 * Repo paths come from lib/infra/repo-paths (env-overridable registry).
 */
export function getWorkingDirectory(sourceRepo: string | null | undefined): string {
  if (!sourceRepo) return HOME
  return getRepoPath(sourceRepo) ?? HOME
}

/**
 * Build a structured prompt for Claude Code from a board task.
 *
 * Fetches parent (story) and grandparent (epic) context, plus sibling tasks
 * to give the agent awareness of what's already done or in progress.
 */
export async function buildAgentPrompt(task: Task, options?: BuildPromptOptions): Promise<string> {
  let story: Task | null = null
  let epic: Task | null = null
  let siblings: Task[] = []

  // Fetch parent context (story or epic)
  if (task.parent_id) {
    try {
      story = await getTask(task.parent_id)
    } catch {
      // Parent may have been deleted
    }

    // If parent is a story, fetch grandparent (epic)
    if (story && story.task_type === 'story' && story.parent_id) {
      try {
        epic = await getTask(story.parent_id)
      } catch {
        // Grandparent may have been deleted
      }
    }

    // If parent is actually an epic (task directly under epic), re-label
    if (story && story.task_type === 'epic') {
      epic = story
      story = null
    }

    // Fetch siblings under the same parent
    try {
      siblings = await listChildren(task.parent_id)
    } catch {
      // Non-fatal
    }
  }

  const workDir = options?.workingDirectory ?? getWorkingDirectory(task.source_repo)
  const lines: string[] = []

  // --- Header ---
  lines.push(`## Task: ${task.title}`)
  if (task.description) {
    lines.push(task.description)
  }
  lines.push('')

  // --- Context ---
  lines.push('### Context')
  if (epic) lines.push(`- Epic: ${epic.title}`)
  if (story) lines.push(`- Story: ${story.title}`)
  lines.push(`- Priority: P${task.priority}`)
  if (task.estimated_effort) lines.push(`- Effort: ${task.estimated_effort}`)
  if (task.source_repo) lines.push(`- Source repo: ${task.source_repo}`)
  if (task.target_module) lines.push(`- Target module: ${task.target_module}`)
  if (task.skill_required) lines.push(`- Skill required: ${task.skill_required}`)
  lines.push('')

  // --- Related Tasks ---
  if (siblings.length > 1) {
    lines.push('### Related Tasks')
    for (const sib of siblings) {
      const marker = sib.id === task.id ? ' (this task)' : ''
      const statusTag = formatStatusTag(sib.status)
      lines.push(`- ${statusTag} ${sib.title}${marker}`)
    }
    lines.push('')
  }

  // --- Instructions ---
  const branchName = `bot/${task.id.substring(0, 8)}-${slugify(task.title)}`

  lines.push('### Instructions')
  lines.push(`Work in the ${task.source_repo ?? 'project'} repository at ${workDir}.`)
  lines.push('Read the CLAUDE.md file first for project conventions.')
  lines.push('')
  lines.push('**Branch strategy:**')
  lines.push(`1. Create a new branch: \`git checkout -b ${branchName}\``)
  lines.push('2. Make your changes and commit to this branch')
  lines.push('3. Do NOT push to main — only commit to the feature branch')
  lines.push(`4. Push: \`git push -u origin ${branchName}\``)
  lines.push('')
  lines.push('Focus only on this task — do not work on sibling tasks.')
  if (options?.extraInstructions) {
    lines.push(options.extraInstructions)
  }
  lines.push('When done, provide a summary of what was changed.')

  return lines.join('\n')
}

function formatStatusTag(status: TaskStatus): string {
  return `[${status}]`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40)
}
