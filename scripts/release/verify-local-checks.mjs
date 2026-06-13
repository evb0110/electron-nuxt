import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shared.mjs';
import { getReleaseCiEnv } from './policy.mjs';

export function getLocalReleaseCheckCommands() {
    return [
        {
            args: [
                'run',
                'lint',
            ],
            command: 'pnpm',
        },
        {
            args: [
                '--dir',
                'landing',
                'run',
                'check:vendor',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'typecheck',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'check:electron:install',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'check:resources:matrix',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'check:architecture:all',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'test:rust',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'test:release',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'test:bundle-integrity',
            ],
            command: 'pnpm',
        },
    ];
}

export function runLocalReleaseChecks({
    env = getReleaseCiEnv(),
    runCommand = run,
} = {}) {
    // Run the local release gate under CI-mode test semantics so runner-only
    // behavior is more likely to fail before we ever push a release tag.
    for (const command of getLocalReleaseCheckCommands()) {
        runCommand(command.command, command.args, {
            env,
            stdio: 'inherit',
        });
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runLocalReleaseChecks();
}
