# Agent Instructions

These instructions apply to all agents spawned in this project.

## Foundation

Read and follow all instructions in `CLAUDE.md` before starting work. It contains project conventions for TypeScript, Vue, scoped styles, icon bundling, and task completion checks.

If something in this document or in `CLAUDE.md` is erroneous, fix it without being verbose about it.

## Autonomous Continuation

Continue to the next stage of work autonomously after completing the current one.

- Do NOT ask for permission to continue or pause to report progress
- Assess the next logical step and proceed immediately
- Work through all stages sequentially until complete

**Stop only when:**
- Requirements are unclear or contradictory
- Multiple valid approaches exist with significant trade-offs the user should decide
- A destructive or irreversible action falls outside the scope of the original task

**Does NOT require stopping:**
- Moving to the next file or component in a multi-file change
- Fixing lint/type errors introduced by your changes
- Choosing between equivalent implementation approaches
- Deciding the order of subtasks within a clear overall goal

## Branching

Never create or switch branches unless explicitly asked by the user or done by your harness.

## Unrelated Changes

If unrelated changes are already present in the worktree, leave them alone:

- Do not modify, stage, revert, or reset unrelated files
- Only touch files required for the current task
- You may proceed with your own work without asking — just don't interfere with those changes

## Quality gates

1. Run quality gates once the task is complete: `pnpm lint && pnpm typecheck` — do NOT run these after every small change, it slows you down massively
2. Fix any lint or type errors before committing

## Release Changes

If you touch release scripts, packaging, Electron automation startup, or workflow launch paths:

- Keep `pnpm run release:verify` host-only and deterministic; do not add steps that mutate tracked files as a side effect
- Add host-independent unit coverage for cross-platform decisions, because local release verification only packages the current host platform
- Prefer comments near the release code when a check is intentionally narrower than the GitHub release matrix

## Cross-Arch Checks

If your change touches Electron runtime, native binaries/tools, OCR/DjVu paths, workers, or packaging, run architecture checks before finishing:

1. `pnpm lint && pnpm typecheck`
2. `pnpm run check:resources:matrix`
3. If a packaged build exists for a target, run `scripts/verify-packaged-native-tools.sh <mac|win|linux> <x64|arm64>`

Do not ship Electron changes that rely on `eval` workers or runtime package lookup in production paths.

## Verification with Electron Puppeteer

Only use the `electron-puppeteer` skill when explicitly requested by the user. Never decide on its use autonomously.

- The skill is located at `.claude/skills/electron-puppeteer/SKILL.md` — read it to understand available commands
- Verify changes in large batches, not piecemeal
- If any verification script breaks, investigate and fix the issue
