import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shared.mjs';
import {
    getLocalReleaseCheckGateScripts,
    getReleaseCiEnv,
} from './policy.mjs';

const SKIP_ACK_ENV_VAR = 'EVB_RELEASE_VERIFY_SKIP_ACK';

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

export function isReleaseVerifySkipAcknowledged({
    argv = process.argv.slice(2),
    env = process.env,
} = {}) {
    return env[SKIP_ACK_ENV_VAR] === '1' || argv.includes('--allow-skip');
}

function writeSkippedGateSummary(skippedScripts, stderr) {
    if (skippedScripts.length === 0) {
        return;
    }

    stderr.write([
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '!! release:verify is running with skipped local gates',
        `!! skipped gates: ${skippedScripts.join(', ')}`,
        `!! acknowledgement: ${SKIP_ACK_ENV_VAR}=1 or --allow-skip`,
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
    ].join('\n'));
}

export function assertReleaseVerifySkipAcknowledged(skippedScripts, {allowSkip} = {}) {
    if (skippedScripts.length === 0 || allowSkip) {
        return;
    }

    throw new Error(
        'EVB_RELEASE_VERIFY_SKIP was set without explicit acknowledgement. '
        + `Set ${SKIP_ACK_ENV_VAR}=1 or pass --allow-skip to skip release gates. `
        + `Requested skipped gates: ${skippedScripts.join(', ')}`,
    );
}

export function getLocalReleaseCheckCommands() {
    return getLocalReleaseCheckGateScripts().map(scriptName => ({
        args: [
            'run',
            scriptName,
        ],
        command: 'pnpm',
    }));
}

export function runLocalReleaseChecks({
    argv = process.argv.slice(2),
    env = getReleaseCiEnv(),
    allowSkip = isReleaseVerifySkipAcknowledged({
        argv,
        env,
    }),
    runCommand = run,
    skipList = env.EVB_RELEASE_VERIFY_SKIP,
    stderr = process.stderr,
} = {}) {
    const commands = getLocalReleaseCheckCommands();
    const knownScripts = commands
        .filter(command => command.args[0] === 'run')
        .map(command => command.args[1]);
    const skippedScripts = parseReleaseVerifySkipList(skipList, {knownScripts});

    assertReleaseVerifySkipAcknowledged(skippedScripts, {allowSkip});
    writeSkippedGateSummary(skippedScripts, stderr);

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
