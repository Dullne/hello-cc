import fs from 'node:fs';
import path from 'node:path';

export function guidanceMarkdown() {
  return `# hello-cc Coordination Rules

This project may be edited by multiple Claude Code and Codex CLI sessions.

Use \`hcc\` as the source of truth for cross-session coordination. If the user
asks what other sessions are doing, do not answer from generic model knowledge.
Run the project-local commands below and summarize the result.

Each terminal session must use a stable peer id, for example codex-a,
codex-b, claude-a, claude-b, or gpu-runner-a.

Status checks:
- \`hcc peers\` shows known Claude/Codex/shell sessions.
- \`hcc task list\` shows all open tasks. Tasks stay visible until \`done\` or
  \`abandoned\`; they are not read/unread items.
- \`hcc msg inbox\` shows unread messages for this session.
- \`hcc lock list\` shows active advisory locks.
- \`hcc status\` summarizes peers, tasks, locks, inbox, and recent events.
- \`hcc team status --task N\` summarizes explicit subtasks for a parent task.

Read-only work:
- Reading files, searching, inspecting \`git diff\` / \`git status\`, reviewing
  uncommitted changes, and running non-mutating checks such as \`node --check\`
  do not require locks.
- For read-only review, do not acquire file locks. If another live peer already
  holds write locks on changed files, report that the review is only a current
  snapshot and not a final commit-ready verdict.
- Use tasks, messages, events, or handoffs to make read-only review visible;
  do not use advisory locks to reserve files you are only reading.

Review and monitoring:
- Reviewing another peer's work is a read-only activity. You may inspect current
  diffs, task state, messages, handoffs, and non-mutating checks while that peer
  keeps its write locks.
- If you find a concrete issue in another peer's task, proactively send that
  peer an \`hcc msg\` with the task id, affected file or behavior, why it is a
  problem, and a suggested fix or verification step.
- Continue monitoring until the peer fixes the issue, records a follow-up task,
  or hands off. Do not silently treat a snapshot review as final approval.

Before mutating work:
- Register with hcc.
- Read current status with \`hcc status\`, \`hcc state\`, \`hcc task list\`, and \`hcc msg inbox\`.
- If \`hcc state\` shows a current task for this peer, continue that task until
  handoff, done, or blocked instead of claiming a new task.
- Claim one task before editing or mutating shared state when this peer has no
  current task.
- If work needs multiple peers, use \`hcc team plan\` and \`hcc team start\`
  explicitly; do not create or claim hidden extra tasks.

Before editing or mutating shared resources:
- Acquire an advisory lock for the file, directory, module, or shared resource.
- If another live peer holds the lock, message that peer instead of editing.
- Acquire locks only before writes or shared-resource mutation, including file
  edits, formatting, staging/committing through \`.git/index\`, intentional DB
  data/schema changes, starting/stopping/restarting shared runtimes, or taking
  over tmux/session/port resources.
- Commit-readiness checks are read-only until staging begins. Do not lock source
  files for review. Before committing, ensure no live peer holds write locks on
  the files to be committed, then lock \`.git/index\` only while staging and
  committing.

During work:
- Keep changes scoped to the claimed task.
- Send progress messages when another session needs context.

Before stopping:
- Mark the task done or blocked.
- Create a handoff with changed files, tests, and remaining risks.
- Release locks you no longer need.
`;
}

export function writeGuidance(root) {
  const guidePath = path.join(root, '.hello-cc', 'HCC.md');
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  const content = guidanceMarkdown();
  fs.writeFileSync(guidePath, content);
  const clause = `\n<!-- hello-cc:start -->\n\n${content}\n<!-- hello-cc:end -->\n`;
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, clause.trimStart());
      continue;
    }
    const existing = fs.readFileSync(target, 'utf8');
    const updated = existing.includes('<!-- hello-cc:start -->')
      ? existing.replace(/<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->/, clause.trim())
      : `${existing.trimEnd()}\n${clause}`;
    fs.writeFileSync(target, updated);
  }
  return guidePath;
}

export function removeGuidanceBlocks(root) {
  const changed = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    const existing = fs.readFileSync(target, 'utf8');
    const updated = existing
      .replace(/\n?<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    if (updated !== existing) {
      fs.writeFileSync(target, updated ? `${updated}\n` : '');
      changed.push(target);
    }
  }
  return changed;
}
