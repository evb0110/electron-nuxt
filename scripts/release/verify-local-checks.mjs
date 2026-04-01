import { run } from './shared.mjs';
import { getReleaseCiEnv } from './policy.mjs';

function main() {
    const releaseCiEnv = getReleaseCiEnv();

    // Run the local release gate under CI-mode test semantics so runner-only
    // behavior is more likely to fail before we ever push a release tag.
    run('pnpm', [
        'run',
        'validate',
    ], {
        env: releaseCiEnv,
        stdio: 'inherit',
    });

    run('pnpm', [
        'run',
        'check:electron:install',
    ], {
        env: releaseCiEnv,
        stdio: 'inherit',
    });

    // Keep release-critical tests fast and deterministic. Manual Electron E2E
    // coverage remains available, but it no longer blocks version cuts.
    run('pnpm', [
        'run',
        'test:release',
    ], {
        env: releaseCiEnv,
        stdio: 'inherit',
    });
}

main();
