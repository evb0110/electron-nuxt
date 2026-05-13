import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { safeDestr } from 'destr';
import { DEFAULT_NUXT_PORT } from './electronRunPortConfig';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from './electronRunProtocol';
import {
    getCurrentSessionName,
    sessionDir,
    sessionFilePath,
    sessionLogFilePath,
    sessionStartingFilePath,
    sessionsBaseDir,
} from './electronRunSessionPaths';
import { isProcessAlive } from './electronRunProcessTree';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from './electronRunSessionTypes';

type TJsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TJsonRecord {
    return typeof value === 'object' && value !== null;
}

function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNullablePositiveInt(value: unknown): value is number | null {
    return value === null || isPositiveInt(value);
}

function parseJsonFile(path: string) {
    try {
        return safeDestr(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function isSessionInfo(value: unknown): value is ISessionInfo {
    if (!isRecord(value)) {
        return false;
    }
    if (
        !isPositiveInt(value.port)
        || !isPositiveInt(value.pid)
        || !isPositiveInt(value.cdpPort)
        || !isNullablePositiveInt(value.electronPid)
        || !isNullablePositiveInt(value.nuxtPid)
    ) {
        return false;
    }
    // Backward compat: older session files may lack nuxtPort.
    if (value.nuxtPort !== undefined && !isPositiveInt(value.nuxtPort)) {
        return false;
    }
    return true;
}

function normalizeSessionInfo(raw: ISessionInfo): ISessionInfo {
    return {
        ...raw,
        nuxtPort: raw.nuxtPort || DEFAULT_NUXT_PORT,
    };
}

function isSessionStartingInfo(value: unknown): value is ISessionStartingInfo {
    if (!isRecord(value)) {
        return false;
    }
    return isPositiveInt(value.pid) && isPositiveInt(value.startedAt);
}

export function getSessionInfo(name = getCurrentSessionName()): ISessionInfo | null {
    const raw = parseJsonFile(sessionFilePath(name));
    if (!isSessionInfo(raw)) {
        return null;
    }
    return normalizeSessionInfo(raw);
}

export function getSessionStartingInfo(name = getCurrentSessionName()): ISessionStartingInfo | null {
    const raw = parseJsonFile(sessionStartingFilePath(name));
    if (!isSessionStartingInfo(raw)) {
        return null;
    }
    return raw;
}

export function readSessionLogTail(maxLines = 80) {
    try {
        const text = readFileSync(sessionLogFilePath(), 'utf8');
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
    } catch {
        return '';
    }
}

export function markSessionStarting(pid: number) {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        pid,
        startedAt: Date.now(),
    }));
}

export function clearSessionStarting(name = getCurrentSessionName()) {
    try {
        unlinkSync(sessionStartingFilePath(name));
    } catch {}
}

export function isSessionStarting(name = getCurrentSessionName()) {
    const info = getSessionStartingInfo(name);
    if (!info) {
        return false;
    }
    const startupAge = Date.now() - info.startedAt;
    if (startupAge > 5 * 60_000 || !isProcessAlive(info.pid)) {
        clearSessionStarting(name);
        return false;
    }
    return true;
}

export async function cleanupStaleSessionArtifacts(name = getCurrentSessionName()) {
    const info = getSessionInfo(name);
    if (info && !isProcessAlive(info.pid)) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }

    const starting = getSessionStartingInfo(name);
    if (starting && !isProcessAlive(starting.pid)) {
        clearSessionStarting(name);
    }

    if (info && !(await isSessionRunning(name)) && !isProcessAlive(info.pid)) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }
}

export async function isSessionRunning(name = getCurrentSessionName()): Promise<boolean> {
    const info = getSessionInfo(name);
    if (!info) {
        return false;
    }

    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: 'ping' satisfies TElectronRunCommand,
                args: [],
            }),
        });
        if (!res.ok) {
            return false;
        }
        const responsePayload = parseElectronRunCommandResponse(await res.json());
        return Boolean(responsePayload?.success);
    } catch {
        if (!isProcessAlive(info.pid)) {
            try {
                unlinkSync(sessionFilePath(name));
            } catch {}
        }
        return false;
    }
}

export function listAllSessionNames() {
    try {
        return readdirSync(sessionsBaseDir).filter(name => {
            try {
                return existsSync(sessionFilePath(name)) || existsSync(sessionStartingFilePath(name));
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

export function listRunningSessions(): string[] {
    const all = listAllSessionNames();
    const running: string[] = [];
    for (const name of all) {
        const info = getSessionInfo(name);
        if (info && isProcessAlive(info.pid)) {
            running.push(name);
        }
    }
    return running;
}
