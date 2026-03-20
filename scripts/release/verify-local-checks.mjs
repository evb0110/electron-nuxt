import { run } from './shared.mjs';

function main() {
    const releaseAutomationEnv = {
        ...process.env,
        EVB_AUTOMATION_HIDE_WINDOW: '1',
        EVB_AUTOMATION_NO_FOCUS: '1',
    };

    run('pnpm', [
        'run',
        'validate',
    ], {stdio: 'inherit'});

    run('pnpm', [
        'run',
        'check:electron:install',
    ], {stdio: 'inherit'});

    run('pnpm', [ 'test' ], { stdio: 'inherit' });

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
