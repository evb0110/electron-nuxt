import {
    existsSync,
    readFileSync,
    watchFile,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { validateSessionName } from '@scripts/electron-run/electronRunSessionPaths';

interface IDevLogsOptions {
    follow: boolean;
    sessionName: string;
    sinceMs: number | null;
    tailLines: number;
}

interface ILogManifest {
    sessionLogFile?: string;
    runDir?: string;
}

function parseSince(value: string, nowMs: number) {
    const duration = /^(\d+)(ms|s|m|h|d)$/u.exec(value);
    if (duration) {
        const amount = Number(duration[1]);
        const unitMs = {
            ms: 1,
            s: 1_000,
            m: 60_000,
            h: 3_600_000,
            d: 86_400_000,
        }[duration[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
        return nowMs - amount * unitMs;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid --since value: ${value}. Use an ISO timestamp or a duration such as 15m.`);
    }
    return timestamp;
}

export function parseDevLogsArgs(args: readonly string[], nowMs = Date.now()): IDevLogsOptions {
    let follow = false;
    let sessionName = 'default';
    let sinceMs: number | null = null;
    let tailLines = 200;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--follow' || arg === '-f') {
            follow = true;
        } else if (arg === '--session' || arg === '-s') {
            sessionName = args[++index] ?? '';
        } else if (arg?.startsWith('--session=')) {
            sessionName = arg.slice('--session='.length);
        } else if (arg === '--since') {
            sinceMs = parseSince(args[++index] ?? '', nowMs);
        } else if (arg?.startsWith('--since=')) {
            sinceMs = parseSince(arg.slice('--since='.length), nowMs);
        } else if (arg === '--tail' || arg === '-n') {
            tailLines = Number(args[++index]);
        } else if (arg?.startsWith('--tail=')) {
            tailLines = Number(arg.slice('--tail='.length));
        } else {
            throw new Error(`Unknown argument: ${arg ?? '<missing>'}`);
        }
    }

    validateSessionName(sessionName);
    if (!Number.isSafeInteger(tailLines) || tailLines < 0) {
        throw new Error('--tail must be a non-negative integer.');
    }
    return {
        follow,
        sessionName,
        sinceMs,
        tailLines,
    };
}

function readManifest(path: string): ILogManifest | null {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as ILogManifest;
    } catch {
        return null;
    }
}

export function filterDevLogText(text: string, options: Pick<IDevLogsOptions, 'sinceMs' | 'tailLines'>) {
    let lines = text.split('\n');
    if (options.sinceMs !== null) {
        let currentTimestamp: number | null = null;
        lines = lines.filter((line) => {
            const match = /^\[([^\s\]]+)/u.exec(line);
            if (match) {
                const parsed = Date.parse(match[1] ?? '');
                if (Number.isFinite(parsed)) currentTimestamp = parsed;
            }
            return currentTimestamp === null || currentTimestamp >= options.sinceMs!;
        });
    }
    if (options.tailLines > 0 && lines.length > options.tailLines) {
        lines = lines.slice(-options.tailLines);
    }
    return lines.join('\n').replace(/^\n+/u, '');
}

export function runDevLogs(args = process.argv.slice(2)) {
    const options = parseDevLogsArgs(args);
    const sessionDir = join(projectRoot, '.devkit', 'sessions', options.sessionName);
    const manifestFile = join(sessionDir, 'logs.json');
    const manifest = readManifest(manifestFile);
    const sessionLogFile = manifest?.sessionLogFile ?? join(sessionDir, 'session.log');
    if (!existsSync(sessionLogFile)) {
        throw new Error(`No log is available for session '${options.sessionName}'. Expected ${sessionLogFile}`);
    }

    process.stderr.write(`[dev:logs] session=${options.sessionName}\n`);
    process.stderr.write(`[dev:logs] log=${sessionLogFile}\n`);
    if (manifest?.runDir) process.stderr.write(`[dev:logs] run=${manifest.runDir}\n`);

    let content = readFileSync(sessionLogFile, 'utf8');
    const initial = filterDevLogText(content, options);
    if (initial) process.stdout.write(initial.endsWith('\n') ? initial : `${initial}\n`);
    let offset = Buffer.byteLength(content);

    if (!options.follow) {
        return;
    }

    watchFile(sessionLogFile, {interval: 250}, (current) => {
        if (current.size < offset) offset = 0;
        if (current.size === offset) {
            return;
        }
        content = readFileSync(sessionLogFile, 'utf8');
        const appended = Buffer.from(content).subarray(offset).toString('utf8');
        offset = Buffer.byteLength(content);
        if (appended) process.stdout.write(appended);
    });
}

const isDirectRun = process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
if (isDirectRun) {
    try {
        runDevLogs();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
