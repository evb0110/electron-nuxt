import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { safeJsonParse } from '@contracts/safeJsonParse';
import { DEFAULT_NUXT_PORT } from '@scripts/electron-run/electronRunPortConfig';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from '@scripts/electron-run/electronRunProtocol';
import { isJsonRecord } from '@scripts/electron-run/isJsonRecord';
import {
    getCurrentSessionName,
    sessionDir,
    electronUserDataPath,
    sessionFilePath,
    sessionLogFilePath,
    sessionStartingFilePath,
    sessionsBaseDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import { E2E_RUN_ID_ENV } from '@scripts/electron-run/electronRunRunId';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    findSessionOwnedElectronPids,
    isVerifiedSessionProcess,
    killVerifiedSessionProcess,
} from '@scripts/electron-run/electronRunProcessIdentity';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionTypes';

function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNullablePositiveInt(value: unknown): value is number | null {
    return value === null || isPositiveInt(value);
}

function parseJsonFile(path: string) {
    try {
        return safeJsonParse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function isSessionInfo(value: unknown): value is ISessionInfo {
    if (!isJsonRecord(value)) {
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
        runId: typeof raw.runId === 'string' ? raw.runId : null,
    };
}

function isSessionStartingInfo(value: unknown): value is ISessionStartingInfo {
    if (!isJsonRecord(value)) {
        return false;
    }
    return isPositiveInt(value.pid) && isPositiveInt(value.startedAt);
}

function normalizeSessionStartingInfo(raw: ISessionStartingInfo): ISessionStartingInfo {
    const electronPids = Array.isArray(raw.electronPids)
        ? raw.electronPids.filter(isPositiveInt)
        : [];
    const cdpPorts = Array.isArray(raw.cdpPorts)
        ? raw.cdpPorts.filter(isPositiveInt)
        : [];
    return {
        pid: raw.pid,
        startedAt: raw.startedAt,
        electronPids,
        cdpPorts,
        electronUserDataDir: typeof raw.electronUserDataDir === 'string' && raw.electronUserDataDir.length > 0
            ? raw.electronUserDataDir
            : null,
        nuxtPid: isNullablePositiveInt(raw.nuxtPid) ? raw.nuxtPid : null,
        nuxtPort: isNullablePositiveInt(raw.nuxtPort) ? raw.nuxtPort : null,
        runId: typeof raw.runId === 'string' ? raw.runId : null,
    };
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
    return normalizeSessionStartingInfo(raw);
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
        electronPids: [],
        cdpPorts: [],
        electronUserDataDir: electronUserDataPath(),
        nuxtPid: null,
        nuxtPort: null,
        runId: process.env[E2E_RUN_ID_ENV] ?? null,
    }));
}

export function recordSessionStartingAttempt(update: Partial<Pick<
    ISessionStartingInfo,
    'electronPids' | 'cdpPorts' | 'electronUserDataDir' | 'nuxtPid' | 'nuxtPort'
>>) {
    const current = getSessionStartingInfo();
    if (!current) {
        return;
    }
    const electronPids = [
        ...current.electronPids,
        ...(update.electronPids ?? []),
    ].filter(isPositiveInt);
    const cdpPorts = [
        ...current.cdpPorts,
        ...(update.cdpPorts ?? []),
    ].filter(isPositiveInt);
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        ...current,
        electronPids: [...new Set(electronPids)],
        cdpPorts: [...new Set(cdpPorts)],
        electronUserDataDir: update.electronUserDataDir ?? current.electronUserDataDir,
        nuxtPid: update.nuxtPid ?? current.nuxtPid,
        nuxtPort: update.nuxtPort ?? current.nuxtPort,
    }));
}

export function clearSessionStarting(name = getCurrentSessionName()) {
    try {
        unlinkSync(sessionStartingFilePath(name));
    } catch {}
}

async function killRecordedStartingProcesses(
    name: string,
    starting: ISessionStartingInfo,
    options: { killNuxt?: boolean } = {},
) {
    const electronUserDataDir = starting.electronUserDataDir ?? electronUserDataPath(name);
    const killedElectronPids = new Set<number>();
    const cdpPorts = starting.cdpPorts.length > 0 ? starting.cdpPorts : [null];
    for (const cdpPort of cdpPorts) {
        const expectation = {
            kind: 'electron' as const,
            sessionName: name,
            cdpPort,
            electronUserDataDir,
        };
        const candidatePids = new Set([
            ...starting.electronPids,
            ...findSessionOwnedElectronPids(expectation),
        ]);
        for (const electronPid of candidatePids) {
            if (killedElectronPids.has(electronPid)) {
                continue;
            }
            const killed = await killVerifiedSessionProcess({
                pid: electronPid,
                expectation,
                graceMs: 800,
            });
            if (killed) {
                killedElectronPids.add(electronPid);
            }
        }
    }

    if (options.killNuxt !== false && starting.nuxtPid && isProcessAlive(starting.nuxtPid)) {
        await killVerifiedSessionProcess({
            pid: starting.nuxtPid,
            expectation: {
                kind: 'nuxt',
                sessionName: name,
                nuxtPort: starting.nuxtPort,
            },
            graceMs: 1200,
        });
    }
}

export async function cleanupSessionStartingAttempt(
    name = getCurrentSessionName(),
    options: { killNuxt?: boolean } = {},
) {
    const starting = getSessionStartingInfo(name);
    if (!starting) {
        return;
    }
    clearSessionStarting(name);
    await killRecordedStartingProcesses(name, starting, options);
    clearSessionStarting(name);
}

export function isSessionStarting(name = getCurrentSessionName()) {
    const info = getSessionStartingInfo(name);
    if (!info) {
        return false;
    }
    const startupAge = Date.now() - info.startedAt;
    const controllerOwned = isVerifiedSessionProcess(info.pid, {
        kind: 'controller',
        sessionName: name,
    });
    if (startupAge > 5 * 60_000 || !controllerOwned) {
        clearSessionStarting(name);
        return false;
    }
    return true;
}

export async function cleanupStaleSessionArtifacts(name = getCurrentSessionName()) {
    const info = getSessionInfo(name);
    const controllerOwned = Boolean(info && isVerifiedSessionProcess(info.pid, {
        kind: 'controller',
        sessionName: name,
    }));
    if (info && !controllerOwned) {
        if (info.electronPid && isProcessAlive(info.electronPid)) {
            await killVerifiedSessionProcess({
                pid: info.electronPid,
                expectation: {
                    kind: 'electron',
                    sessionName: name,
                    cdpPort: info.cdpPort,
                },
                graceMs: 800,
            });
        }
        if (info.nuxtPid && isProcessAlive(info.nuxtPid)) {
            await killVerifiedSessionProcess({
                pid: info.nuxtPid,
                expectation: {
                    kind: 'nuxt',
                    sessionName: name,
                    nuxtPort: info.nuxtPort,
                },
                graceMs: 1200,
            });
        }
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }

    const starting = getSessionStartingInfo(name);
    if (starting && !isVerifiedSessionProcess(starting.pid, {
        kind: 'controller',
        sessionName: name,
    })) {
        await cleanupSessionStartingAttempt(name);
    }

    if (info && !(await isSessionRunning(name)) && !controllerOwned) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }
}

export async function isSessionRunning(name = getCurrentSessionName()) {
    const info = getSessionInfo(name);
    if (!info) {
        return false;
    }
    if (!isVerifiedSessionProcess(info.pid, {
        kind: 'controller',
        sessionName: name,
    })) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
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
        if (info && isVerifiedSessionProcess(info.pid, {
            kind: 'controller',
            sessionName: name,
        })) {
            running.push(name);
        }
    }
    return running;
}
