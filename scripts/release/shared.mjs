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
