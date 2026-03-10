import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VALID_RELEASE_LEVELS = new Set([
    'patch',
    'minor',
    'major',
]);

function run(command, args, options = {}) {
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

function assertCleanWorktree() {
    const porcelain = run('git', [
        'status',
        '--short',
    ]);
    if (porcelain.length > 0) {
        throw new Error('Release requires a clean worktree');
    }
}

function readVersion() {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
}

function revertVersionCommit(version) {
    process.stderr.write(`Hosted preflight failed for v${version}; reverting unreleased version bump.\n`);
    run('git', [
        'revert',
        '--no-edit',
        'HEAD',
    ], {stdio: 'inherit'});
    run('git', ['push'], {stdio: 'inherit'});
}

async function main() {
    const level = process.argv[2];
    if (!VALID_RELEASE_LEVELS.has(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    assertCleanWorktree();

    run('pnpm', [
        'run',
        'release:verify',
    ], {stdio: 'inherit'});
    run('pnpm', [
        'version',
        level,
        '--no-git-tag-version',
    ], {stdio: 'inherit'});

    const version = readVersion();
    const tag = `v${version}`;

    run('git', [
        'add',
        'package.json',
    ], {stdio: 'inherit'});
    run('git', [
        'commit',
        '-m',
        version,
    ], {stdio: 'inherit'});
    run('git', ['push'], {stdio: 'inherit'});

    try {
        run('node', ['scripts/release/run-hosted-preflight.mjs'], {stdio: 'inherit'});
    } catch (error) {
        revertVersionCommit(version);
        throw error;
    }

    run('git', [
        'tag',
        tag,
    ], {stdio: 'inherit'});
    run('git', [
        'push',
        'origin',
        tag,
    ], {stdio: 'inherit'});
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
