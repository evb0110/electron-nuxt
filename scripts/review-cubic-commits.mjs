import {
    spawn,
    spawnSync,
} from 'node:child_process';
import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
} from 'node:fs';
import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {collectPrePushWork} from './check-commit-attribution.mjs';

const REVIEW_CACHE_DIRECTORY = 'cubic-reviews';
const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_DELAY_MS = 5 * 1000;

class CubicOperationalError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'CubicOperationalError';
    }
}

function runGit(arguments_, cwd = process.cwd()) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
    });
    if (result.error) {
        throw new Error(`git ${arguments_.join(' ')} failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim();
        throw new Error(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout.trim();
}

export function resolveReviewTimeout(env = process.env) {
    const configured = Number(env.CUBIC_REVIEW_TIMEOUT_MS);
    return Number.isSafeInteger(configured) && configured > 0
        ? configured
        : DEFAULT_REVIEW_TIMEOUT_MS;
}

function executableExists(candidate) {
    try {
        accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function resolveCubicBinary({
    env = process.env,
    homeDirectory = homedir(),
    platform = process.platform,
} = {}) {
    if (env.CUBIC_BIN) {
        return executableExists(env.CUBIC_BIN) ? env.CUBIC_BIN : null;
    }

    const binaryNames = platform === 'win32'
        ? [
            'cubic.exe',
            'cubic.cmd',
            'cubic',
        ]
        : ['cubic'];
    for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        for (const binaryName of binaryNames) {
            const candidate = path.join(directory, binaryName);
            if (executableExists(candidate)) {
                return candidate;
            }
        }
    }

    for (const binaryName of binaryNames) {
        const installedCandidate = path.join(homeDirectory, '.cubic', 'bin', binaryName);
        if (executableExists(installedCandidate)) {
            return installedCandidate;
        }
    }
    return null;
}

function quoteCmdToken(token) {
    const unsafeCharacters = [
        '\r',
        '\n',
        '"',
        '&',
        '|',
        '<',
        '>',
        '^',
        '%',
        '!',
    ];
    if (unsafeCharacters.some(character => token.includes(character))) {
        throw new Error('Cubic Windows command contains unsupported shell metacharacters');
    }
    return `"${token}"`;
}

export function cubicInvocation(binary, arguments_, {
    env = process.env,
    platform = process.platform,
} = {}) {
    if (platform !== 'win32' || path.extname(binary).toLowerCase() !== '.cmd') {
        return {
            arguments: arguments_,
            command: binary,
        };
    }

    const commandLine = [
        binary,
        ...arguments_,
    ].map(quoteCmdToken).join(' ');
    return {
        arguments: [
            '/d',
            '/s',
            '/c',
            commandLine,
        ],
        command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    };
}

function parseEvent(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function cubicEnvironment(env = process.env) {
    return {
        ...env,
        CUBIC_DISABLE_AUTOUPDATE: env.CUBIC_DISABLE_AUTOUPDATE ?? '1',
    };
}

export function classifyTerminalEvent(event, exitCode = 0) {
    if (event?.type === 'review.completed') {
        const issues = Array.isArray(event.issues) ? event.issues : [];
        if (event.outcome === 'clean' && issues.length === 0) {
            return {
                kind: 'clean',
                issues,
            };
        }
        if (issues.length > 0 && issues.every(issue => (
            issue?.priority === 'P2' || issue?.priority === 'P3'
        ))) {
            return {
                kind: 'advisory',
                issues,
            };
        }
        return {
            kind: 'findings',
            issues,
        };
    }

    return {
        kind: 'failed',
        message: event?.error?.message
            ?? `cubic exited with code ${exitCode} without a terminal review event`,
    };
}

function reportEvent(event) {
    if (!event) {
        return;
    }
    if (event.type === 'review.started') {
        process.stderr.write('[cubic] review started\n');
        return;
    }
    if (event.type === 'review.heartbeat') {
        process.stderr.write(`[cubic] still reviewing after ${Math.round((event.elapsed_ms ?? 0) / 1000)}s\n`);
        return;
    }
    if (event.type === 'item.started' && event.label) {
        process.stderr.write(`[cubic] ${event.label}\n`);
        return;
    }
    if (event.type?.includes('finding')) {
        process.stderr.write(`[cubic] ${JSON.stringify(event)}\n`);
    }
}

async function runCubicReview(binary, commit, cwd) {
    const invocation = cubicInvocation(binary, [
        'review',
        '--commit',
        commit,
        '--output-format',
        'stream-json',
    ]);
    const child = spawn(invocation.command, invocation.arguments, {
        cwd,
        env: cubicEnvironment(),
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });

    child.stderr.pipe(process.stderr);
    let terminalEvent = null;
    const output = createInterface({input: child.stdout});
    output.on('line', (line) => {
        const event = parseEvent(line);
        if (event?.type === 'review.completed' || event?.type === 'review.failed') {
            terminalEvent = event;
        }
        reportEvent(event);
    });
    const outputClosed = new Promise(resolve => output.once('close', resolve));

    let timedOut = false;
    let forceKillTimer = null;
    const timeoutMs = resolveReviewTimeout();
    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS);
    }, timeoutMs);
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', error => reject(new CubicOperationalError(error.message, {cause: error})));
        child.once('close', code => resolve(code ?? 1));
    }).finally(() => {
        clearTimeout(timeout);
        if (forceKillTimer !== null) {
            clearTimeout(forceKillTimer);
        }
    });
    await outputClosed;
    if (timedOut) {
        return {
            kind: 'failed',
            message: `review timed out after ${Math.round(timeoutMs / 1000)}s`,
        };
    }
    return classifyTerminalEvent(terminalEvent, exitCode);
}

function cubicVersion(binary, cwd) {
    const invocation = cubicInvocation(binary, ['--version']);
    const result = spawnSync(invocation.command, invocation.arguments, {
        cwd,
        encoding: 'utf8',
        env: cubicEnvironment(),
    });
    return result.status === 0 ? result.stdout.trim() || 'unknown' : 'unknown';
}

function cubicAuthenticationReady(binary, cwd) {
    const invocation = cubicInvocation(binary, [
        'auth',
        'list',
    ]);
    const result = spawnSync(invocation.command, invocation.arguments, {
        cwd,
        encoding: 'utf8',
        env: cubicEnvironment(),
    });
    return result.status === 0 && !/(?:^|\s)0 credentials(?:\s|$)/u.test(result.stdout);
}

export function cacheMarkerName(commit, version) {
    return `${commit}-${version.replace(/[^0-9A-Za-z._-]+/gu, '_')}.passed`;
}

async function cachePath(commit, version, cwd) {
    const gitDirectory = runGit([
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
    ], cwd);
    const directory = path.join(gitDirectory, REVIEW_CACHE_DIRECTORY);
    await mkdir(directory, {recursive: true});
    return path.join(directory, cacheMarkerName(commit, version));
}

async function commitsFromArguments(arguments_, cwd) {
    const prePushIndex = arguments_.indexOf('--pre-push');
    const commitIndex = arguments_.indexOf('--commit');
    if (prePushIndex !== -1 && commitIndex !== -1) {
        throw new Error('--pre-push and --commit are mutually exclusive');
    }
    if (prePushIndex !== -1) {
        if (prePushIndex !== 0 || arguments_.length > 3) {
            throw new Error('Usage: review-cubic-commits.mjs --pre-push <remote> [<url>]');
        }
        const remoteName = arguments_[prePushIndex + 1];
        if (!remoteName) {
            throw new Error('--pre-push requires the remote name');
        }
        const input = readFileSync(0, 'utf8');
        return collectPrePushWork(input, [
            remoteName,
            arguments_[prePushIndex + 2],
        ], cwd).commits;
    }

    if (commitIndex !== -1 && (commitIndex !== 0 || arguments_.length !== 2)) {
        throw new Error('Usage: review-cubic-commits.mjs --commit <revision>');
    }
    if (commitIndex === -1 && arguments_.length > 0) {
        throw new Error(`Unknown argument: ${arguments_[0]}`);
    }
    const revision = commitIndex === -1 ? 'HEAD' : arguments_[commitIndex + 1];
    if (!revision) {
        throw new Error('--commit requires a revision');
    }
    return [runGit([
        'rev-parse',
        '--verify',
        `${revision}^{commit}`,
    ], cwd)];
}

export async function main(arguments_ = process.argv.slice(2), cwd = process.cwd()) {
    const commits = await commitsFromArguments(arguments_, cwd);
    const binary = resolveCubicBinary();
    if (!binary) {
        process.stderr.write('[cubic] warning: CLI not found; continuing without the auxiliary review\n');
        return 0;
    }
    if (!cubicAuthenticationReady(binary, cwd)) {
        process.stderr.write(
            '[cubic] warning: CLI is not authenticated; run `cubic auth login` interactively; '
            + 'continuing without the auxiliary review\n',
        );
        return 0;
    }
    if (commits.length === 0) {
        process.stderr.write('[cubic] no unpublished commits to review\n');
        return 0;
    }

    const version = cubicVersion(binary, cwd);
    for (const commit of commits) {
        const marker = version === 'unknown' ? null : await cachePath(commit, version, cwd);
        if (marker !== null && process.env.CUBIC_REVIEW_FORCE !== '1' && existsSync(marker)) {
            process.stderr.write(`[cubic] ${commit.slice(0, 12)} already passed with cubic ${version}\n`);
            continue;
        }

        process.stderr.write(`[cubic] reviewing local commit ${commit.slice(0, 12)} with cubic ${version}\n`);
        let result;
        try {
            result = await runCubicReview(binary, commit, cwd);
        } catch (error) {
            if (!(error instanceof CubicOperationalError)) {
                throw error;
            }
            result = {
                kind: 'failed',
                message: error.message,
            };
        }
        if (result.kind === 'clean' || result.kind === 'advisory') {
            if (result.kind === 'advisory') {
                for (const issue of result.issues) {
                    process.stderr.write(`[cubic] advisory: ${JSON.stringify(issue)}\n`);
                }
            }
            if (marker !== null) {
                await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
            }
            process.stderr.write(
                result.kind === 'clean'
                    ? `[cubic] ${commit.slice(0, 12)} passed\n`
                    : `[cubic] ${commit.slice(0, 12)} passed with ${result.issues.length} advisory finding(s)\n`,
            );
            continue;
        }
        if (result.kind === 'findings') {
            for (const issue of result.issues) {
                process.stderr.write(`[cubic] finding: ${JSON.stringify(issue)}\n`);
            }
            process.stderr.write(
                `[cubic] commit ${commit.slice(0, 12)} has ${result.issues.length || 'one or more'} finding(s); push blocked\n`,
            );
            return 1;
        }

        process.stderr.write(
            `[cubic] warning: review failed for ${commit.slice(0, 12)}: ${result.message}; `
            + 'continuing because Cubic is an auxiliary gate\n',
        );
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.exitCode = await main();
    } catch (error) {
        process.stderr.write(
            `[cubic] local gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
    }
}
