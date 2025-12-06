// Request processor - handles context injection from team memory
// Reference: plan_proxy_local.md Section 2.1

import {
  getTasksForProject,
  getTasksByFiles,
  getStepsReasoningByPath,
  type Task,
  type UserRole,
} from '../lib/store.js';
import { truncate } from '../lib/utils.js';

/**
 * Build context from team memory for injection
 * Queries tasks and file_reasoning tables
 * @param role - Optional role for role-specific formatting (manager/developer)
 */
export function buildTeamMemoryContext(
  projectPath: string,
  mentionedFiles: string[],
  role?: UserRole
): string | null {
  // Get recent completed tasks for this project
  const tasks = getTasksForProject(projectPath, {
    status: 'complete',
    limit: 10,
  });

  // Get tasks that touched mentioned files
  const fileTasks = mentionedFiles.length > 0
    ? getTasksByFiles(projectPath, mentionedFiles, { status: 'complete', limit: 5 })
    : [];

  // Get file-level reasoning from steps table (proxy version)
  const fileReasonings = mentionedFiles.length > 0
    ? mentionedFiles.flatMap(f => getStepsReasoningByPath(f, 3))
    : [];

  // Combine unique tasks
  const allTasks = [...new Map([...tasks, ...fileTasks].map(t => [t.id, t])).values()];

  if (allTasks.length === 0 && fileReasonings.length === 0) {
    return null;
  }

  return formatTeamMemoryContext(allTasks, fileReasonings, mentionedFiles, role);
}

/**
 * Format team memory context for injection
 * Role-aware: Manager sees decisions/constraints, Developer sees files/reasoning
 */
function formatTeamMemoryContext(
  tasks: Task[],
  fileReasonings: Array<{ file_path: string; anchor?: string; reasoning: string }>,
  files: string[],
  role?: UserRole
): string {
  const lines: string[] = [];

  lines.push('[GROV CONTEXT - Relevant past reasoning]');
  lines.push('');

  // File-level context (more detailed for developer)
  if (fileReasonings.length > 0) {
    lines.push('File-level context:');
    const limit = role === 'developer' ? 8 : 3;  // Developer gets more file details
    for (const fr of fileReasonings.slice(0, limit)) {
      const anchor = fr.anchor ? ` (${fr.anchor})` : '';
      const reasoningLimit = role === 'developer' ? 150 : 80;
      lines.push(`- ${fr.file_path}${anchor}: ${truncate(fr.reasoning, reasoningLimit)}`);
    }
    lines.push('');
  }

  // Task context - role-specific formatting
  if (tasks.length > 0) {
    lines.push('Related past tasks:');
    for (const task of tasks.slice(0, 5)) {
      lines.push(`- ${truncate(task.original_query, 60)}`);

      if (role === 'manager') {
        // Manager focus: decisions, constraints, high-level scope
        if (task.decisions && task.decisions.length > 0) {
          lines.push(`  Decision: ${task.decisions[0].choice}`);
          if (task.decisions[0].reason) {
            lines.push(`  Reason: ${truncate(task.decisions[0].reason, 80)}`);
          }
        }
        if (task.constraints && task.constraints.length > 0) {
          lines.push(`  Constraints: ${task.constraints.slice(0, 3).join(', ')}`);
        }
      } else {
        // Developer focus: files, implementation details, reasoning
        if (task.files_touched.length > 0) {
          const fileList = task.files_touched.slice(0, 5).map(f => f.split('/').pop()).join(', ');
          lines.push(`  Files: ${fileList}`);
        }
        if (task.reasoning_trace.length > 0) {
          lines.push(`  Key: ${truncate(task.reasoning_trace[0], 100)}`);
        }
        // Developer also sees constraints as implementation guidelines
        if (task.constraints && task.constraints.length > 0) {
          lines.push(`  Must follow: ${task.constraints.slice(0, 2).join(', ')}`);
        }
      }
    }
    lines.push('');
  }

  if (files.length > 0) {
    lines.push(`You may already have context for: ${files.join(', ')}`);
  }
  lines.push('[END GROV CONTEXT]');

  return lines.join('\n');
}

/**
 * Extract file paths from messages
 */
export function extractFilesFromMessages(
  messages: Array<{ role: string; content: unknown }>
): string[] {
  const files: string[] = [];
  const filePattern = /(?:^|\s|["'`])([\/\w.-]+\.[a-zA-Z]{1,10})(?:["'`]|\s|$|:|\))/g;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      let match;
      while ((match = filePattern.exec(msg.content)) !== null) {
        const path = match[1];
        // Filter out common false positives
        if (!path.includes('http') && !path.startsWith('.') && path.length > 3) {
          files.push(path);
        }
      }
    }
  }

  return [...new Set(files)];
}
