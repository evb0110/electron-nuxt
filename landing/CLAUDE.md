# Landing Rules

- Keep the landing app self-contained for Vercel deployment from `landing/`.
- Import shared code through `landing/vendor/`, not `../packages/*`.
- After changing `packages/contracts`, `packages/i18n-core`, or `packages/release-selection`, run `pnpm sync:vendor` from `landing/` and commit the vendor update.
- Use `pnpm check:vendor` to catch vendor drift.
