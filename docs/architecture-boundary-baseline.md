# Architecture Boundary Baseline

## Snapshot
- Date: February 27, 2026
- Scope: dependency boundaries, feature public entrypoints, and cycle prevention
- Enforcement surfaces: ESLint guardrails + CI architecture scripts

## Enforced Boundaries
- `electron/**` cannot import `app/**`
- `landing/**` cannot import `app/**`
- `app/services/**` cannot import `app/composables/**`
- Cross-feature imports in `app/modules/*` and `electron/features/*` must use public entrypoints only
- Import cycles are blocked (`import/no-cycle` as an error)

## Tooling
- `scripts/architecture/dep-graph.mjs`: builds internal dependency graph (`app`, `electron`, `landing`, `packages/contracts`)
- `scripts/architecture/boundary-check.mjs`: fails on boundary violations using the dependency graph

## CI Contract
- CI must run dependency graph generation and boundary checks in the required quality workflow before test/build packaging phases.
