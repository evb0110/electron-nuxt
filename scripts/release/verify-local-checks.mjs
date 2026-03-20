import { run } from './shared.mjs';

function main() {
    const releaseCiEnv = {
        ...process.env,
        CI: 'true',
    };
    const releaseAutomationEnv = {
        ...releaseCiEnv,
        EVB_AUTOMATION_HIDE_WINDOW: '1',
        EVB_AUTOMATION_NO_FOCUS: '1',
    };

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

    run('pnpm', [ 'test' ], {
        env: releaseCiEnv,
        stdio: 'inherit',
    });

    // validate already ran build:strict, which includes build:electron. Reusing
    // that build keeps release verification closer to CI while avoiding one more
    // rebuild before the smoke lane starts.
    run('pnpm', [
        'run',
        'test:e2e:electron:smoke:no-build',
    ], {
        env: releaseAutomationEnv,
        stdio: 'inherit',
    });
}

main();
