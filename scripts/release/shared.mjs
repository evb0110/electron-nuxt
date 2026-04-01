import { execFileSync } from 'node:child_process';
import {
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export const VALID_RELEASE_LEVELS = new Set([
    'patch',
    'minor',
    'major',
]);

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

export function shouldSkipGitHubReleaseWait(env = process.env) {
    return env.EVB_RELEASE_SKIP_GITHUB_WAIT === '1';
}

export function assertGitHubCliReady(context = 'Release') {
    if (shouldSkipGitHubReleaseWait()) {
        return;
    }

    try {
        run('gh', [
            'auth',
            'status',
        ]);
    } catch {
        throw new Error(
            `${context} requires an authenticated GitHub CLI session so the release command `
            + 'can wait for the tag-triggered workflow. '
            + 'Run `gh auth status` / `gh auth login`, or set EVB_RELEASE_SKIP_GITHUB_WAIT=1 '
            + 'to opt out explicitly.',
        );
    }
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

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

export function assertCleanWorktree() {
    const porcelain = run('git', [
        'status',
        '--short',
    ]);
    if (porcelain.length > 0) {
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

export function getHeadSha(ref = 'HEAD') {
    return run('git', [
        'rev-parse',
        ref,
    ]);
}

export function getUpstream() {
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
            `Release requires the current branch to track a remote branch (${errorMessage(error)})`,
        );
    }
}

export function listChangedFiles() {
    const trackedOutput = run('git', [
        'diff',
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
        untrackedOutput,
    ]) {
        if (output.length === 0) {
            continue;
        }

        for (const file of output.split('\n')) {
            const normalizedFile = file.trim();
            if (normalizedFile.length > 0) {
                files.add(normalizedFile);
            }
        }
    }

    return Array.from(files);
}

export function assertChangedFilesMatch(expectedFiles, context = 'Release') {
    const expected = new Set(expectedFiles);
    const changedFiles = listChangedFiles();
    const unexpected = changedFiles.filter(file => !expected.has(file));
    const missing = expectedFiles.filter(file => !changedFiles.includes(file));

    if (unexpected.length === 0 && missing.length === 0) {
        return;
    }

    const details = [
        unexpected.length > 0
            ? `unexpected changes: ${unexpected.join(', ')}`
            : '',
        missing.length > 0
            ? `missing changes: ${missing.join(', ')}`
            : '',
    ].filter(Boolean).join('; ');

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

export function assertTagAbsent(tag, remote) {
    const localStatus = (() => {
        try {
            run('git', [
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

    try {
        run('git', [
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
        throw error;
    }
}
