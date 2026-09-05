import { getCliErrorMessage } from './lib/cli-error.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_BASE_REFS = ['origin/main'];

export function parseArgs(argv) {
    const options = {
        apply: false,
        help: false,
        into: [...DEFAULT_BASE_REFS],
    };
    for (const arg of argv) {
        if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--into=')) {
            const refs = arg.slice('--into='.length).split(',').map(ref => ref.trim()).filter(Boolean);
            options.into = [...new Set([
                ...options.into,
                ...refs,
            ])];
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

export function parseWorktreeList(porcelain) {
    const worktrees = [];
    let current = null;
    for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = {
                path: line.slice('worktree '.length),
                head: null,
                branch: null,
                detached: false,
                bare: false,
            };
            worktrees.push(current);
        } else if (!current) {
            continue;
        } else if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '');
        } else if (line === 'detached') {
            current.detached = true;
        } else if (line === 'bare') {
            current.bare = true;
        }
    }
    return worktrees;
}

export function classifyWorktree(worktree) {
    if (worktree.isPrimary) {
        return {
            action: 'keep',
            reason: 'primary checkout',
        };
    }
    if (worktree.containsCwd) {
        return {
            action: 'keep',
            reason: 'current working directory',
        };
    }
    if (worktree.missing) {
        return {
            action: 'remove',
            reason: 'directory missing; registration is stale',
        };
    }
    if (worktree.dirtyEntries === null) {
        return {
            action: 'keep',
            reason: 'git status unavailable',
        };
    }
    if (worktree.dirtyEntries > 0) {
        return {
            action: 'keep',
            reason: `${worktree.dirtyEntries} uncommitted change(s)`,
        };
    }
    if (worktree.mergedInto.length === 0) {
        return {
            action: 'keep',
            reason: 'HEAD not merged into any base ref',
        };
    }
    return {
        action: 'remove',
        reason: `merged into ${worktree.mergedInto.join(', ')}`,
    };
}

function git(args, cwd = projectRoot) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
}

function isAncestor(head, baseRef) {
    try {
        execFileSync('git', [
            'merge-base',
            '--is-ancestor',
            head,
            baseRef,
        ], {
            cwd: projectRoot,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

function countDirtyEntries(worktreePath) {
    try {
        return git([
            'status',
            '--porcelain',
            '--untracked-files=normal',
        ], worktreePath).split('\n').filter(Boolean).length;
    } catch {
        return null;
    }
}

function refExists(ref) {
    try {
        git([
            'rev-parse',
            '--verify',
            '--quiet',
            `${ref}^{commit}`,
        ]);
        return true;
    } catch {
        return false;
    }
}

function directorySizeKiB(dirPath) {
    try {
        const output = execFileSync('du', [
            '-sk',
            dirPath,
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        const sizeKiB = Number.parseInt(output.split('\t')[0], 10);
        return Number.isNaN(sizeKiB) ? null : sizeKiB;
    } catch {
        return null;
    }
}

function formatReclaimed(reclaimedKiB) {
    return reclaimedKiB === null
        ? 'reclaimed size unknown (du unavailable)'
        : `reclaimed about ${Math.round(reclaimedKiB / 1024)} MiB`;
}

export async function collectWorktrees(baseRefs) {
    const cwd = await realpath(process.cwd()).catch(() => process.cwd());
    const missingRefs = baseRefs.filter(ref => !refExists(ref));
    if (missingRefs.length > 0) {
        throw new Error(`Unknown base ref(s): ${missingRefs.join(', ')}. Run git fetch --prune origin first.`);
    }
    const entries = parseWorktreeList(git([
        'worktree',
        'list',
        '--porcelain',
    ]));
    const worktrees = [];
    for (const [
        index,
        entry,
    ] of entries.entries()) {
        const worktreePath = await realpath(entry.path).catch(() => entry.path);
        const isPrimary = index === 0;
        const missing = !isPrimary && !existsSync(worktreePath);
        const dirtyEntries = isPrimary || missing
            ? 0
            : countDirtyEntries(worktreePath);
        const mergedInto = isPrimary || !entry.head
            ? []
            : baseRefs.filter(ref => isAncestor(entry.head, ref));
        const worktree = {
            ...entry,
            path: worktreePath,
            isPrimary,
            containsCwd: cwd === worktreePath || cwd.startsWith(`${worktreePath}${path.sep}`),
            missing,
            dirtyEntries,
            mergedInto,
        };
        worktrees.push({
            ...worktree,
            ...classifyWorktree(worktree),
        });
    }
    return worktrees;
}

function formatRow(worktree) {
    const label = worktree.branch ?? (worktree.detached ? `detached ${worktree.head?.slice(0, 9)}` : 'unknown');
    return `${worktree.action.padEnd(6)} ${label.padEnd(44)} ${worktree.reason.padEnd(38)} ${worktree.path}`;
}

export async function pruneWorktrees(options) {
    const worktrees = await collectWorktrees(options.into);
    const removable = worktrees.filter(worktree => worktree.action === 'remove');
    for (const worktree of worktrees) {
        console.log(formatRow(worktree));
    }
    if (removable.length === 0) {
        console.log('No removable worktrees.');
        return {
            removed: [],
            reclaimedKiB: 0,
        };
    }
    if (!options.apply) {
        console.log(`\n${removable.length} worktree(s) would be removed. Re-run with --apply to remove them. Branches are never deleted.`);
        return {
            removed: [],
            reclaimedKiB: 0,
        };
    }

    const removed = [];
    let reclaimedKiB = 0;
    for (const worktree of removable) {
        if (worktree.missing) {
            removed.push(worktree.path);
            console.log(`forgot ${worktree.path} (directory already gone)`);
            continue;
        }
        const sizeKiB = directorySizeKiB(worktree.path);
        try {
            git([
                'worktree',
                'remove',
                worktree.path,
            ]);
            removed.push(worktree.path);
            reclaimedKiB = reclaimedKiB === null || sizeKiB === null
                ? null
                : reclaimedKiB + sizeKiB;
            console.log(`removed ${worktree.path}`);
        } catch (error) {
            console.error(`failed to remove ${worktree.path}: ${getCliErrorMessage(error)}`);
        }
    }
    git([
        'worktree',
        'prune',
    ]);
    console.log(`Removed ${removed.length} worktree(s), ${formatReclaimed(reclaimedKiB)}.`);
    return {
        removed,
        reclaimedKiB,
    };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const USAGE = [
    'Usage: pnpm worktrees:prune [--into=<ref>[,<ref>]] [--apply]',
    '',
    'Lists registered git worktrees and removes the ones whose HEAD is merged into a',
    'base ref (origin/main plus any --into refs) and whose tree is clean. Dry run by',
    'default. Never deletes branches, the primary checkout, dirty trees, or the tree',
    'that contains the current working directory.',
].join('\n');

if (isMain) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            console.log(USAGE);
        } else {
            await pruneWorktrees(options);
        }
    } catch (error) {
        const message = getCliErrorMessage(error);
        console.error(`worktrees-prune: ${message}`);
        console.error(USAGE);
        process.exitCode = 1;
    }
}
