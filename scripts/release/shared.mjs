import { execFileSync } from 'node:child_process';
import {
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compact,
    difference,
} from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export const VALID_RELEASE_LEVELS = new Set([
    'patch',
    'minor',
    'major',
]);

export const MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES = Object.freeze(['landing']);

export function parsePinnedNodeMajor(versionRange, context = 'Release') {
    const match = String(versionRange ?? '').trim().match(/^(\d+)\.x$/);

    if (match?.[1] == null) {
        throw new Error(
            `${context} requires package.json engines.node to use a pinned "<major>.x" range. `
            + `Received "${versionRange ?? ''}".`,
        );
    }

    return Number.parseInt(match[1], 10);
}

export function assertNodeMajor(expectedMajor, context = 'Release') {
    const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

    if (currentMajor === expectedMajor) {
        return;
    }

    throw new Error(
        `${context} requires Node ${expectedMajor}.x (latest LTS). `
        + `Current runtime is ${process.version}. `
        + 'Switch to the version declared in .nvmrc before continuing.',
    );
}

export function assertNodeProjectBaseline(context = 'Release') {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const expectedMajor = parsePinnedNodeMajor(packageJson.engines?.node, context);

    assertNodeMajor(expectedMajor, context);
}

const TRANSIENT_GITHUB_AUTH_ERROR_PATTERNS = [
    /Timeout trying to log in/i,
    /keyring/i,
    /context deadline exceeded/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /TLS handshake timeout/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

export function isTransientGitHubAuthError(error) {
    const message = errorMessage(error);

    return TRANSIENT_GITHUB_AUTH_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export async function assertGitHubCliReady(context = 'Release', {
    attempts = 3,
    delayMs = 5_000,
    runCommand = run,
    sleepFn = sleep,
    stderr = process.stderr,
} = {}) {
    let finalTransientError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            runCommand('gh', [
                'auth',
                'status',
            ]);
            return;
        } catch (error) {
            const isTransient = isTransientGitHubAuthError(error);
            if (attempt < attempts && isTransient) {
                finalTransientError = error;
                stderr.write(
                    'Transient GitHub CLI auth check failure '
                    + `(attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s.\n`,
                );
                await sleepFn(delayMs);
                continue;
            }

            finalTransientError = isTransient ? error : null;
            break;
        }
    }

    if (finalTransientError) {
        try {
            const login = runCommand('gh', [
                'api',
                'graphql',
                '--field',
                'query=query { viewer { login } }',
                '--jq',
                '.data.viewer.login',
            ]);
            if (!String(login).trim()) {
                throw new Error('Authenticated GraphQL viewer login was empty');
            }
            stderr.write(
                'GitHub CLI auth status remained unavailable; authenticated GraphQL fallback succeeded.\n',
            );
            return;
        } catch {
            // Report the standard actionable authentication error below.
        }
    }

    throw new Error(
        `${context} requires an authenticated GitHub CLI session so this command `
        + 'can dispatch the GitHub workflow. '
        + 'Run `gh auth status` / `gh auth login`.',
    );
}

export function run(command, args, options = {}) {
    const output = execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        ...options,
    });

    if (output == null) {
        return '';
    }

    return String(output).trim();
}

export const sleep = delay;

export function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export function getExitStatus(error) {
    if (
        error
        && typeof error === 'object'
        && 'status' in error
        && typeof error.status === 'number'
    ) {
        return error.status;
    }

    return undefined;
}

const TRANSIENT_REMOTE_GIT_ERROR_PATTERNS = [
    /Recv failure/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /TLS handshake timeout/i,
    /Could not resolve host/i,
    /Failed to connect/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

export function isTransientRemoteGitError(error) {
    const message = errorMessage(error);

    return TRANSIENT_REMOTE_GIT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function assertCleanWorktree({ ignoredPathPrefixes = [] } = {}) {
    const changedFiles = listChangedFiles({ ignoredPathPrefixes });
    if (changedFiles.length > 0) {
        throw new Error('Release requires a clean worktree');
    }
}

export function requireNamedBranch(context = 'Release') {
    const branch = run('git', [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]);
    if (branch === 'HEAD') {
        throw new Error(`${context} requires a named branch, not detached HEAD`);
    }

    return branch;
}

export function readVersion() {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
}

export function writeVersion(version) {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.version = version;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

export function restoreVersionIfChanged(
    expectedVersion,
    {
        readVersionFn = readVersion,
        stderr = process.stderr,
        writeVersionFn = writeVersion,
    } = {},
) {
    const actualVersion = readVersionFn();
    if (actualVersion === expectedVersion) {
        return false;
    }

    stderr.write(
        `Release verification changed package.json version from ${expectedVersion} to ${actualVersion}; `
        + `restoring ${expectedVersion} before committing.\n`,
    );
    writeVersionFn(expectedVersion);
    return true;
}

export function bumpVersion(version, level) {
    const match = version.match(SEMVER_PATTERN);
    if (!match) {
        throw new Error(`Expected package.json version to be x.y.z, received "${version}"`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);

    if (level === 'patch') {
        return `${major}.${minor}.${patch + 1}`;
    }

    if (level === 'minor') {
        return `${major}.${minor + 1}.0`;
    }

    if (level === 'major') {
        return `${major + 1}.0.0`;
    }

    throw new Error(`Unsupported release level "${level}"`);
}

export function getUpstream(context = 'Release') {
    try {
        const upstream = run('git', [
            'rev-parse',
            '--abbrev-ref',
            '--symbolic-full-name',
            '@{upstream}',
        ]);
        const separatorIndex = upstream.indexOf('/');
        if (separatorIndex <= 0 || separatorIndex === upstream.length - 1) {
            throw new Error(`Unsupported upstream ref "${upstream}"`);
        }

        return {
            branch: upstream.slice(separatorIndex + 1),
            ref: upstream,
            remote: upstream.slice(0, separatorIndex),
        };
    } catch (error) {
        throw new Error(
            `${context} requires the current branch to track a remote branch (${errorMessage(error)})`,
        );
    }
}

function assertReleaseMainBranchName(branch, context) {
    if (branch !== 'main') {
        throw new Error(`${context} requires the current branch to be main, received "${branch}"`);
    }
}

function assertReleaseMainUpstream(upstream, context) {
    if (
        upstream.branch !== 'main'
        || upstream.ref !== 'origin/main'
        || upstream.remote !== 'origin'
    ) {
        throw new Error(
            `${context} requires main to track origin/main, received "${upstream.ref}"`,
        );
    }

    return upstream;
}

export function getReleaseMainUpstream(context = 'Release', {
    readBranch = requireNamedBranch,
    readUpstream = getUpstream,
} = {}) {
    const branch = readBranch(context);
    assertReleaseMainBranchName(branch, context);

    return assertReleaseMainUpstream(readUpstream(context), context);
}

// Resolved from this module, so the gate does not depend on the caller's cwd.
export const PUBLICATION_POLICY_SCRIPT = fileURLToPath(
    new URL('../check-commit-attribution.mjs', import.meta.url),
);

/**
 * Arguments for the publication policy scan over everything a push would make
 * public. `--pushed-range` falls back to the full history of the head when the
 * before SHA is empty or unreachable, which is the fail-closed direction. For a
 * release push, an unreachable before SHA is rejected earlier
 * (`assertUpstreamBeforeShaPresent`) so the widened scan cannot be mistaken for
 * a clean gate over a stale checkout.
 */
export function getPublicationPolicyCheckArgs(beforeSha, headSha) {
    return [
        PUBLICATION_POLICY_SCRIPT,
        '--pushed-range',
        beforeSha,
        headSha,
    ];
}

// The remote's live advertisement, not a tracking ref: a tracking ref can be
// stale in either direction, and the range to scan has to start where the branch
// actually is on the remote. A branch the remote does not have yet advertises
// nothing, so the before SHA is empty and the scan widens to the head's full
// history; an unreachable remote makes `ls-remote` fail and aborts the push.
function readUpstreamBeforeSha({
    branch,
    remote,
}, runCommand) {
    const output = runCommand('git', [
        'ls-remote',
        remote,
        `refs/heads/${branch}`,
    ]);

    return output.split('\n')[0]?.split(/\s+/u)[0]?.trim() ?? '';
}

function hasLocalCommit(oid, runCommand) {
    try {
        runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `${oid}^{commit}`,
        ]);
        return true;
    } catch {
        return false;
    }
}

/**
 * A commit the remote advertises but this checkout does not contain means the
 * checkout is stale: someone else pushed since the last fetch. The scan itself
 * would still run — it cannot exclude an object it does not have, so it widens
 * to the head's whole history and reports every artifact any historical commit
 * ever touched, which reads as a policy failure rather than as "fetch first".
 *
 * Fail closed here instead, before the scan, with the remedy named. Fetching is
 * deliberately left to the operator: a release must publish the history the
 * operator verified, not one this script silently moved underneath them.
 */
export function assertUpstreamBeforeShaPresent(beforeSha, {
    branch,
    remote,
}, runCommand) {
    // A branch the remote does not have yet advertises nothing; the scan then
    // covers the head's full history, which is correct for a new branch.
    if (!beforeSha || hasLocalCommit(beforeSha, runCommand)) {
        return;
    }

    throw new Error(
        `Release cannot verify what this push would publish: ${remote}/${branch} is at ${beforeSha}, `
        + 'which is missing from this checkout, so the publication scan has no starting point. '
        + `Run \`git fetch ${remote} ${branch}\`, reconcile HEAD with the fetched tip, and retry.`,
    );
}

/**
 * The single publication gate: scans the range this push would make public, then
 * pushes `HEAD` to the upstream branch. Returns the pushed SHA so callers can
 * dispatch a workflow against exactly what was published.
 *
 * Every release entry point runs with `HUSKY=0`, so the pre-push hook never sees
 * these pushes, and the version-bump commit `cut-release` creates carries
 * `[skip ci]`, so the CI attribution job does not see it either. This scan is
 * therefore the only check standing between the local branch and the public one.
 * A failing scan throws out of here, so the push — and any dispatch a caller
 * would run afterwards — cannot happen.
 */
export function pushReleaseBranch({upstream}, {runCommand = run} = {}) {
    const targetSha = runCommand('git', [
        'rev-parse',
        'HEAD',
    ]);

    const beforeSha = readUpstreamBeforeSha(upstream, runCommand);
    assertUpstreamBeforeShaPresent(beforeSha, upstream, runCommand);

    runCommand(
        'node',
        getPublicationPolicyCheckArgs(beforeSha, targetSha),
        {stdio: 'inherit'},
    );

    runCommand('git', [
        'push',
        upstream.remote,
        `HEAD:${upstream.branch}`,
    ], {stdio: 'inherit'});

    return targetSha;
}

function normalizeGitPath(filePath) {
    return filePath.replaceAll('\\', '/');
}

function normalizeIgnoredPathPrefixes(ignoredPathPrefixes) {
    return compact(ignoredPathPrefixes.map(prefix => normalizeGitPath(prefix).replace(/\/+$/u, '')));
}

export function filterIgnoredFiles(files, ignoredPathPrefixes = []) {
    const ignoredPrefixes = normalizeIgnoredPathPrefixes(ignoredPathPrefixes);

    if (ignoredPrefixes.length === 0) {
        return files;
    }

    return files.filter((file) => {
        const normalizedFile = normalizeGitPath(file);
        return !ignoredPrefixes.some(prefix => (
            normalizedFile === prefix
            || normalizedFile.startsWith(`${prefix}/`)
        ));
    });
}

export function listChangedFiles({ ignoredPathPrefixes = [] } = {}) {
    const trackedOutput = run('git', [
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
    ]);
    const stagedOutput = run('git', [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
    ]);
    const untrackedOutput = run('git', [
        'ls-files',
        '--others',
        '--exclude-standard',
    ]);

    const files = new Set();

    for (const output of [
        trackedOutput,
        stagedOutput,
        untrackedOutput,
    ]) {
        if (output.length === 0) {
            continue;
        }

        for (const normalizedFile of compact(output.split('\n').map(file => file.trim()))) {
            files.add(normalizedFile);
        }
    }

    return filterIgnoredFiles(Array.from(files), ignoredPathPrefixes);
}

function normalizeChangedFileAssertionOptions(contextOrOptions) {
    if (typeof contextOrOptions === 'string') {
        return {
            context: contextOrOptions,
            ignoredPathPrefixes: [],
        };
    }

    return {
        context: contextOrOptions?.context ?? 'Release',
        ignoredPathPrefixes: contextOrOptions?.ignoredPathPrefixes ?? [],
    };
}

export function assertChangedFilesMatch(expectedFiles, contextOrOptions = 'Release') {
    const {
        context,
        ignoredPathPrefixes,
    } = normalizeChangedFileAssertionOptions(contextOrOptions);
    const changedFiles = listChangedFiles({ ignoredPathPrefixes });
    const unexpected = difference(changedFiles, expectedFiles);
    const missing = difference(expectedFiles, changedFiles);

    if (unexpected.length === 0 && missing.length === 0) {
        return;
    }

    const details = compact([
        unexpected.length > 0
            ? `unexpected changes: ${unexpected.join(', ')}`
            : '',
        missing.length > 0
            ? `missing changes: ${missing.join(', ')}`
            : '',
    ]).join('; ');

    throw new Error(
        `${context} verification must leave only the expected release file set changed (${expectedFiles.join(', ')}); ${details}`,
    );
}

export function stageFiles(files) {
    if (files.length === 0) {
        throw new Error('Version bump did not produce any file changes');
    }

    run('git', [
        'add',
        '--',
        ...files,
    ], {stdio: 'inherit'});
}

export async function assertTagAbsent(tag, remote, {
    attempts = 3,
    delayMs = 5_000,
    runCommand = run,
    sleepFn = sleep,
    stderr = process.stderr,
} = {}) {
    const localStatus = (() => {
        try {
            runCommand('git', [
                'rev-parse',
                '--verify',
                `refs/tags/${tag}`,
            ]);
            return 0;
        } catch (error) {
            const status = getExitStatus(error);
            if (status === 128) {
                return status;
            }
            throw error;
        }
    })();

    if (localStatus === 0) {
        throw new Error(`Tag ${tag} already exists locally`);
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            runCommand('git', [
                'ls-remote',
                '--exit-code',
                '--tags',
                remote,
                `refs/tags/${tag}`,
            ]);
            throw new Error(`Tag ${tag} already exists on ${remote}`);
        } catch (error) {
            const status = getExitStatus(error);
            if (status === 2) {
                return;
            }

            if (attempt < attempts && isTransientRemoteGitError(error)) {
                stderr.write(
                    `Transient remote tag check failure for ${tag} `
                    + `(attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s.\n`,
                );
                await sleepFn(delayMs);
                continue;
            }

            throw error;
        }
    }
}
