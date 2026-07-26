import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const ZERO_OID = '0'.repeat(40);

export const FORBIDDEN_ATTRIBUTION_RULES = [
    {
        label: 'Claude co-author trailer',
        pattern: /^\s*co-authored-by:\s*claude(?:\s|<|$)/imu,
    },
    {
        label: 'Anthropic no-reply identity',
        pattern: /\bnoreply@anthropic\.com\b/iu,
    },
    {
        label: 'Claude generated-by marker',
        pattern: /\bgenerated\s+with\s+\[?claude\b/iu,
    },
    {
        label: 'Claude session trailer',
        pattern: /^\s*claude-session\s*:/imu,
    },
];

function runGit(arguments_, cwd = process.cwd()) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

export function findForbiddenAttribution(text) {
    return FORBIDDEN_ATTRIBUTION_RULES
        .filter(({pattern}) => pattern.test(text))
        .map(({label}) => label);
}

export function parsePrePushUpdates(input) {
    return input
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
            const fields = line.trim().split(/\s+/u);
            if (fields.length !== 4) {
                throw new Error(`Invalid pre-push update: ${line}`);
            }
            const [
                localRef,
                localOid,
                remoteRef,
                remoteOid,
            ] = fields;
            return {
                localRef,
                localOid,
                remoteRef,
                remoteOid,
            };
        });
}

function listCommits(arguments_, cwd) {
    return runGit([
        'rev-list',
        '--reverse',
        ...arguments_,
    ], cwd)
        .split(/\r?\n/u)
        .filter(Boolean);
}

export function collectPrePushCommits(input, remoteName, cwd = process.cwd()) {
    const commits = new Set();
    for (const update of parsePrePushUpdates(input)) {
        if (update.localOid === ZERO_OID) {
            continue;
        }
        const revisionArguments = update.remoteOid === ZERO_OID
            ? [
                update.localOid,
                '--not',
                `--remotes=${remoteName}`,
            ]
            : [`${update.remoteOid}..${update.localOid}`];
        for (const commit of listCommits(revisionArguments, cwd)) {
            commits.add(commit);
        }
    }
    return [...commits];
}

export function collectRangeCommits(ranges, cwd = process.cwd()) {
    const commits = new Set();
    for (const range of ranges) {
        for (const commit of listCommits([range], cwd)) {
            commits.add(commit);
        }
    }
    return [...commits];
}

function readCommitAttribution(commit, cwd) {
    return runGit([
        'show',
        '--no-patch',
        '--format=%an%n%ae%n%cn%n%ce%n%B',
        commit,
    ], cwd);
}

export function findCommitViolations(commits, cwd = process.cwd()) {
    return commits.flatMap((commit) => {
        const matches = findForbiddenAttribution(readCommitAttribution(commit, cwd));
        return matches.length > 0 ? [{
            commit,
            matches,
        }] : [];
    });
}

function rejectViolations(violations) {
    if (violations.length === 0) {
        return;
    }
    console.error('Push blocked: prohibited Claude attribution was found.');
    for (const {
        commit,
        matches,
    } of violations) {
        console.error(`  ${commit}: ${matches.join(', ')}`);
    }
    console.error('Remove the attribution marker or identity, rewrite the affected commit, and retry.');
    process.exitCode = 1;
}

function readOptionValues(arguments_, option) {
    const values = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] === option) {
            const value = arguments_[index + 1];
            if (!value) {
                throw new Error(`${option} requires a value`);
            }
            values.push(value);
            index += 1;
        } else if (arguments_[index].startsWith(`${option}=`)) {
            values.push(arguments_[index].slice(option.length + 1));
        }
    }
    return values;
}

export function main(arguments_ = process.argv.slice(2), cwd = process.cwd()) {
    const messageFiles = readOptionValues(arguments_, '--message-file');
    const ranges = readOptionValues(arguments_, '--range');
    const prePushIndex = arguments_.indexOf('--pre-push');

    if (messageFiles.length === 1 && ranges.length === 0 && prePushIndex === -1) {
        const matches = findForbiddenAttribution(readFileSync(messageFiles[0], 'utf8'));
        if (matches.length > 0) {
            console.error(`Commit blocked: prohibited Claude attribution was found (${matches.join(', ')}).`);
            process.exitCode = 1;
        }
        return;
    }

    if (ranges.length > 0 && messageFiles.length === 0 && prePushIndex === -1) {
        rejectViolations(findCommitViolations(collectRangeCommits(ranges, cwd), cwd));
        return;
    }

    if (prePushIndex !== -1 && messageFiles.length === 0 && ranges.length === 0) {
        const remoteName = arguments_[prePushIndex + 1];
        if (!remoteName) {
            throw new Error('--pre-push requires the remote name');
        }
        const input = readFileSync(0, 'utf8');
        rejectViolations(findCommitViolations(
            collectPrePushCommits(input, remoteName, cwd),
            cwd,
        ));
        return;
    }

    throw new Error(
        'Usage: check-commit-attribution.mjs '
        + '(--message-file <path> | --range <revision> [--range <revision>] | --pre-push <remote>)',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
