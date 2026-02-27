# Codebase Sanity Overhaul Baseline

## Snapshot
- Date: February 24, 2026
- Scope: full codebase sanity + robustness overhaul (no internal back-compat shims)
- Input baseline source: parallel architecture/frontend/electron/tooling audits plus local verification runs

## Starting Risk Profile
- Estimated size: ~330 TypeScript/Vue files, ~73k LOC
- High-risk hotspots:
  - `app/components/DocumentWorkspace.vue`
  - `app/composables/page/useWorkspaceOrchestration.ts`
  - `app/composables/pdf/useAnnotationCommentCrud.ts`
  - `electron/ocr/jobManager.ts`
  - `electron/utils/path-validator.ts`
- Known debt at start:
  - `typecheck` passing
  - read-only lint failing with 8 issues (including correctness issues in annotation comment/note-window flows)

## Baseline Quality Commands
Executed for traceability at overhaul start/end phase boundaries:

```bash
pnpm run lint:check
pnpm run typecheck
pnpm test
pnpm run build:electron
```

## Baseline Debt Tracking Policy
- No mutating lint auto-fixes during initial diagnosis.
- Runtime hardening and type-boundary fixes prioritized before broad cleanup.
- Full quality/cross-arch gate batch executed once major refactors are merged.

## Success Criteria For This Overhaul
- OCR/Electron boundary failures return typed error envelopes.
- Malformed OCR payloads and missing worker files do not crash the app.
- Symlink escape attempts are denied for read/write paths.
- Workspace and PDF UI orchestration reduced into explicit domain controllers.
- Deduplicated scroll/context-menu primitives and safer pdf.js adapter boundaries.
- CI/release parity enforces quality gates before packaging.

## Architecture Baseline Addendum (February 27, 2026)
- Boundary enforcement is now codified in ESLint and CI (not documentation-only).
- Dependency graph + boundary checks live in `scripts/architecture/dep-graph.mjs` and `scripts/architecture/boundary-check.mjs`.
- Reference policy document: `docs/architecture-boundary-baseline.md`.
