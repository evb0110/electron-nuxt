import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shared.mjs';
import { getReleaseCiEnv } from './policy.mjs';

export function parseReleaseVerifySkipList(rawSkipList, {knownScripts} = {}) {
    const requested = (rawSkipList ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);

    if (knownScripts) {
        const unknown = requested.filter(entry => !knownScripts.includes(entry));

        if (unknown.length > 0) {
            throw new Error(
                `EVB_RELEASE_VERIFY_SKIP references unknown release gates: ${unknown.join(', ')}. `
                + `Known gates: ${knownScripts.join(', ')}`,
            );
        }
    }

    return requested;
}

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
                'check:wasm:portable',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'check:architecture',
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
                'test:coverage',
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
    skipList = process.env.EVB_RELEASE_VERIFY_SKIP,
    stderr = process.stderr,
} = {}) {
    const commands = getLocalReleaseCheckCommands();
    const knownScripts = commands
        .filter(command => command.args[0] === 'run')
        .map(command => command.args[1]);
    const skippedScripts = parseReleaseVerifySkipList(skipList, {knownScripts});

    for (const script of skippedScripts) {
        stderr.write(`release:verify: skipping ${script} (EVB_RELEASE_VERIFY_SKIP)\n`);
    }

    // Run the local release gate under CI-mode test semantics so runner-only
    // behavior is more likely to fail before we ever push a release tag.
    for (const command of commands) {
        if (command.args[0] === 'run' && skippedScripts.includes(command.args[1])) {
            continue;
        }

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
