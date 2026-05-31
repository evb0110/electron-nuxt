import { isMainThread } from 'worker_threads';
import { tmpdir } from 'os';
import {
    mkdirSync,
    statSync,
} from 'fs';
import {
    appendFile,
    readdir,
    rename,
    rm,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/ipc/coreContract';

interface ILogMessage {
    source: string;
    message: string;
    timestamp: string;
}

interface ILogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

interface ILoggerOptions {broadcastToRenderers?: boolean;}

interface IFileLogState {
    queue: Promise<void>;
    initialized: boolean;
    approximateBytes: number;
    pendingWrites: number;
    droppedWrites: number;
}

type TLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<TLogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
};

const FILE_LOG_LEVEL = normalizeLogLevel(process.env.ELECTRON_FILE_LOG_LEVEL) ?? 'DEBUG';
const RENDER_LOG_LEVEL = normalizeLogLevel(process.env.ELECTRON_RENDER_LOG_LEVEL)
    ?? 'WARN';
const LOG_FILE_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_MAX_BYTES ?? `${5 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 256 * 1024) {
        return 5 * 1024 * 1024;
    }
    return Math.min(parsed, 256 * 1024 * 1024);
})();
const LOG_FILE_MAX_BACKUPS = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_MAX_BACKUPS ?? '3', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 3;
    }
    return Math.min(parsed, 16);
})();
const LOG_DIR_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_DIR_MAX_BYTES ?? `${64 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024 * 1024) {
        return 64 * 1024 * 1024;
    }
    return Math.min(parsed, 2 * 1024 * 1024 * 1024);
})();
const LOG_WRITE_QUEUE_MAX_PENDING = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_QUEUE_MAX_PENDING ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 2_000;
    }
    return Math.min(parsed, 100_000);
})();
const LOG_DIR_PRUNE_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_DIR_PRUNE_INTERVAL_MS ?? `${60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 60 * 1_000;
    }
    return parsed;
})();

const LOG_DIR = join(tmpdir(), 'electron-logs');
const fileLogStates = new Map<string, IFileLogState>();
let logDirPruneLastAt = 0;
let logDirPrunePromise: Promise<void> | null = null;

function normalizeLogLevel(value: unknown): TLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toUpperCase();
    if (normalized === 'DEBUG' || normalized === 'INFO' || normalized === 'WARN' || normalized === 'ERROR') {
        return normalized;
    }

    return null;
}

function shouldLog(level: TLogLevel, minLevel: TLogLevel) {
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

try {
    mkdirSync(LOG_DIR, { recursive: true });
} catch {
    // Ignore if already exists
}

async function broadcastToRenderers(data: ILogMessage) {
    if (!isMainThread) {
        return;
    }

    try {
        const { BrowserWindow } = await import('electron');
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed() && win.webContents) {
                win.webContents.send(CORE_IPC_EVENT_CHANNELS.debugLog, data);
            }
        }
    } catch {
        // Silently ignore IPC errors in edge cases
    }
}

function ensureState(logFile: string): IFileLogState {
    const existingState = fileLogStates.get(logFile);
    if (existingState) {
        return existingState;
    }

    const nextState: IFileLogState = {
        queue: Promise.resolve(),
        initialized: false,
        approximateBytes: 0,
        pendingWrites: 0,
        droppedWrites: 0,
    };
    fileLogStates.set(logFile, nextState);
    return nextState;
}

async function initializeState(logFile: string, state: IFileLogState) {
    if (state.initialized) {
        return;
    }
    state.initialized = true;

    try {
        await appendFile(logFile, '', 'utf8');
    } catch {
        // Ignore initialization failures, writes will keep retrying.
    }

    try {
        const fileStat = statSync(logFile);
        state.approximateBytes = fileStat.size;
    } catch {
        state.approximateBytes = 0;
    }
}

async function rotateFile(logFile: string) {
    if (LOG_FILE_MAX_BACKUPS <= 0) {
        try {
            await rm(logFile, { force: true });
        } catch {
            // Ignore cleanup failures.
        }
        return;
    }

    for (let index = LOG_FILE_MAX_BACKUPS; index >= 1; index -= 1) {
        const source = index === 1
            ? logFile
            : `${logFile}.${index - 1}`;
        const destination = `${logFile}.${index}`;

        try {
            await rm(destination, { force: true });
        } catch {
            // Ignore destination cleanup failures.
        }

        try {
            await rename(source, destination);
        } catch {
            // Ignore missing source entries.
        }
    }
}

async function pruneLogDirectory(force = false) {
    const now = Date.now();
    if (!force && now - logDirPruneLastAt < LOG_DIR_PRUNE_INTERVAL_MS) {
        return;
    }
    logDirPruneLastAt = now;

    if (logDirPrunePromise) {
        return logDirPrunePromise;
    }

    logDirPrunePromise = (async () => {
        interface IFileEntry {
            path: string;
            size: number;
            mtimeMs: number;
        }

        let entries: string[] = [];
        try {
            entries = await readdir(LOG_DIR);
        } catch {
            return;
        }

        const files: IFileEntry[] = [];
        let totalBytes = 0;

        for (const entry of entries) {
            const filePath = join(LOG_DIR, entry);
            try {
                const fileStat = statSync(filePath);
                if (!fileStat.isFile()) {
                    continue;
                }
                files.push({
                    path: filePath,
                    size: fileStat.size,
                    mtimeMs: fileStat.mtimeMs,
                });
                totalBytes += fileStat.size;
            } catch {
                // Ignore files disappearing while pruning.
            }
        }

        if (totalBytes <= LOG_DIR_MAX_BYTES) {
            return;
        }

        files.sort((left, right) => left.mtimeMs - right.mtimeMs);
        for (const file of files) {
            if (totalBytes <= LOG_DIR_MAX_BYTES) {
                break;
            }

            try {
                await rm(file.path, { force: true });
                totalBytes -= file.size;
                fileLogStates.delete(file.path);
            } catch {
                // Ignore cleanup failures and continue pruning.
            }
        }
    })().finally(() => {
        logDirPrunePromise = null;
    });

    return logDirPrunePromise;
}

function enqueueWrite(
    source: string,
    logFile: string,
    line: string,
) {
    const state = ensureState(logFile);
    if (state.pendingWrites >= LOG_WRITE_QUEUE_MAX_PENDING) {
        state.droppedWrites += 1;
        return;
    }
    state.pendingWrites += 1;

    state.queue = state.queue
        .then(async () => {
            await initializeState(logFile, state);

            const linesToWrite: string[] = [];
            if (state.droppedWrites > 0) {
                linesToWrite.push(
                    `[${new Date().toISOString()}] [${source}] [WARN] `
                    + `Dropped ${state.droppedWrites} buffered log message(s) due to logger backpressure`,
                );
                state.droppedWrites = 0;
            }
            linesToWrite.push(line);
            const payload = `${linesToWrite.join('\n')}\n`;
            const payloadBytes = Buffer.byteLength(payload, 'utf8');

            if (state.approximateBytes + payloadBytes > LOG_FILE_MAX_BYTES) {
                await rotateFile(logFile);
                state.approximateBytes = 0;
            }

            await appendFile(logFile, payload, 'utf8');
            state.approximateBytes += payloadBytes;

            await pruneLogDirectory();
        })
        .catch(() => {
            // Avoid throwing from logger writes.
        })
        .finally(() => {
            state.pendingWrites = Math.max(0, state.pendingWrites - 1);
        });
}

export function createLogger(source: string, options: ILoggerOptions = {}): ILogger {
    const logFile = join(LOG_DIR, `${source}.log`);
    const broadcastToRenderersEnabled = options.broadcastToRenderers ?? true;

    try {
        mkdirSync(dirname(logFile), { recursive: true });
    } catch {
        // Ignore
    }

    function log(level: TLogLevel, msg: string) {
        const ts = new Date().toISOString();
        const formattedMsg = `[${ts}] [${source}] [${level}] ${msg}`;

        if (shouldLog(level, FILE_LOG_LEVEL)) {
            enqueueWrite(source, logFile, formattedMsg);
        }

        if (broadcastToRenderersEnabled && shouldLog(level, RENDER_LOG_LEVEL)) {
            void broadcastToRenderers({
                source,
                message: `[${level}] ${msg}`,
                timestamp: ts,
            });
        }
    }

    return {
        debug: (msg: string) => log('DEBUG', msg),
        info: (msg: string) => log('INFO', msg),
        warn: (msg: string) => log('WARN', msg),
        error: (msg: string) => log('ERROR', msg),
    };
}

void pruneLogDirectory(true).catch(() => {});
