import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shared.mjs';
import {
    RELEASE_BUILD_RECEIPT_ENV_VAR,
    validateReleaseBuildReceipt,
    writeReleaseBuildReceipt,
} from './build-receipt.mjs';
import {
    getLocalReleaseCheckGateScripts,
    getReleaseCiEnv,
} from './policy.mjs';

const SKIP_ACK_ENV_VAR = 'EVB_RELEASE_VERIFY_SKIP_ACK';
const SKIP_LIST_ENV_VAR = 'EVB_RELEASE_VERIFY_SKIP';
const REUSE_BUILD_RECEIPT_ENV_VAR = 'EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT';
const STRICT_BUILD_DUPLICATE_GATES = new Set([
    'build:pdf-image-combine',
    'build:pdf-page-ops',
    'build:pdf-search',
    'build:scan-cleanup',
    'check:wasm:portable',
]);

function environmentForReleaseCheck(env, scriptName) {
    if (scriptName !== 'test:coverage') {
        return env;
    }

    const testEnv = {...env};
    delete testEnv[RELEASE_BUILD_RECEIPT_ENV_VAR];
    delete testEnv[SKIP_ACK_ENV_VAR];
    delete testEnv[SKIP_LIST_ENV_VAR];
    return testEnv;
}

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
    skipList = env[SKIP_LIST_ENV_VAR],
    stderr = process.stderr,
    validateBuildReceipt = validateReleaseBuildReceipt,
    writeBuildReceipt = writeReleaseBuildReceipt,
} = {}) {
    const commands = getLocalReleaseCheckCommands();
    const knownScripts = commands
        .filter(command => command.args[0] === 'run')
        .map(command => command.args[1]);
    const skippedScripts = parseReleaseVerifySkipList(skipList, {knownScripts});

    assertReleaseVerifySkipAcknowledged(skippedScripts, {allowSkip});
    writeSkippedGateSummary(skippedScripts, stderr);
    const receiptPath = env[RELEASE_BUILD_RECEIPT_ENV_VAR];
    const canHandoffStrictBuild = Boolean(receiptPath)
        && skippedScripts.every(script => !STRICT_BUILD_DUPLICATE_GATES.has(script));
    const reusableReceipt = canHandoffStrictBuild
        && env[REUSE_BUILD_RECEIPT_ENV_VAR] === '1'
        && validateBuildReceipt(receiptPath, {env}).valid;
    let strictBuildPrepared = reusableReceipt;
    if (reusableReceipt) {
        stderr.write(`Reusing strict-build receipt from the all-gates validation phase: ${receiptPath}\n`);
    }
    const prepareStrictBuild = () => {
        if (!canHandoffStrictBuild || strictBuildPrepared) {
            return;
        }
        runCommand('pnpm', [
            'run',
            'build:strict',
        ], {
            env,
            stdio: 'inherit',
        });
        writeBuildReceipt(receiptPath, {env});
        stderr.write(
            `Recorded strict-build receipt for the packaging phase: ${receiptPath}\n`,
        );
        strictBuildPrepared = true;
    };

    // Run the local release gate under CI-mode test semantics so runner-only
    // behavior is more likely to fail before we ever push a release tag.
    for (const command of commands) {
        const scriptName = command.args[0] === 'run' ? command.args[1] : undefined;
        if (scriptName && skippedScripts.includes(scriptName)) {
            continue;
        }
        if (canHandoffStrictBuild && scriptName && STRICT_BUILD_DUPLICATE_GATES.has(scriptName)) {
            continue;
        }
        const effectiveCommand = canHandoffStrictBuild
            && scriptName === 'test:electron-bundle-static-integrity'
            ? {
                args: [
                    'run',
                    'test:electron-bundle-static-integrity:no-build',
                ],
                command: 'pnpm',
            }
            : command;
        if (
            canHandoffStrictBuild
            && scriptName === 'test:electron-bundle-static-integrity'
        ) {
            prepareStrictBuild();
        }

        runCommand(effectiveCommand.command, effectiveCommand.args, {
            env: environmentForReleaseCheck(env, scriptName),
            stdio: 'inherit',
        });
    }
    prepareStrictBuild();
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runLocalReleaseChecks();
}
