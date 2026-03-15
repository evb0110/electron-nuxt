import { run } from './shared.mjs';

function main() {
    run('pnpm', [
        'run',
        'validate',
    ], {stdio: 'inherit'});

    run('pnpm', [ 'test' ], { stdio: 'inherit' });

    run('pnpm', [
        'run',
        'test:e2e:electron:smoke',
    ], {
        env: {
            ...process.env,
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        },
        stdio: 'inherit',
    });
}

main();
