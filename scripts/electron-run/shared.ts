import { createServer as createNetServer } from 'node:net';
import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
    Browser,
    ConsoleMessage,
    Page,
} from 'puppeteer-core';
import type { MergeExclusive } from 'type-fest';
import { safeDestr } from 'destr';
import { uniq } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const projectRoot = join(__dirname, '..', '..');

export const DEFAULT_NUXT_PORT = 3235;
let nuxtPort = DEFAULT_NUXT_PORT;

export function getNuxtPort(): number {
    return nuxtPort;
}

export function setNuxtPort(port: number): void {
    if (!Number.isFinite(port) || port <= 0) {
        return;
    }
    nuxtPort = port;
}
export const SESSION_WAIT_TIMEOUT_MS = 60_000;
export const COMMAND_REQUEST_TIMEOUT_MS = 120_000;
export const OPEN_PDF_READY_TIMEOUT_MS = 120_000;
export const OPEN_PDF_TRIGGER_TIMEOUT_MS = 12_000;
export const COMMAND_EXECUTION_TIMEOUT_MS = 180_000;

let currentSessionName = 'default';

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

export const ELECTRON_RUN_COMMANDS = [
    'ping',
    'screenshot',
    'screenshots',
    'console',
    'devtools',
    'run',
    'eval',
    'click',
    'type',
    'content',
    'waitfor',
    'resize',
    'viewport',
    'openPdf',
    'health',
] as const;

export type TElectronRunCommand = typeof ELECTRON_RUN_COMMANDS[number];

const ELECTRON_RUN_COMMAND_SET = new Set<TElectronRunCommand>(ELECTRON_RUN_COMMANDS);

export interface IElectronRunCommandRequest {
    command: TElectronRunCommand;
    args: unknown[];
}

type TElectronRunCommandSuccessResponse = {
    success: true;
    result: unknown;
    error?: never;
};

type TElectronRunCommandFailureResponse = {
    success: false;
    error: string;
    result?: never;
};

export type TElectronRunCommandResponse = MergeExclusive<
    TElectronRunCommandSuccessResponse,
    TElectronRunCommandFailureResponse
>;

export function isElectronRunCommand(value: unknown): value is TElectronRunCommand {
    return typeof value === 'string' && ELECTRON_RUN_COMMAND_SET.has(value as TElectronRunCommand);
}

export function parseElectronRunCommandRequest(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    if (!isElectronRunCommand(value.command)) {
        return null;
    }
    if (!Array.isArray(value.args)) {
        return null;
    }
    return {
        command: value.command,
        args: value.args,
    };
}

export function parseElectronRunCommandResponse(value: unknown) {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        return null;
    }
    if (value.success) {
        return {
            success: true,
            result: value.result,
        };
    }
    if (typeof value.error !== 'string') {
        return null;
    }
    return {
        success: false,
        error: value.error,
    };
}

export function getCurrentSessionName() {
    return currentSessionName;
}

export function setCurrentSessionName(name: string) {
    currentSessionName = name;
}

export const sessionsBaseDir = join(projectRoot, '.devkit', 'sessions');

export function sessionDir(name = getCurrentSessionName()) {
    return join(sessionsBaseDir, name);
}

export function sessionFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.json');
}

export function sessionStartingFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session-starting.json');
}

export function sessionLogFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.log');
}

export function electronUserDataPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'electron-user-data');
}

export function screenshotDirPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'screenshots');
}

export type TConsoleMessageType = ReturnType<ConsoleMessage['type']>;

export interface IConsoleMessage {
    type: TConsoleMessageType;
    text: string;
    timestamp: number;
}

interface IDevtoolsEventBase {timestamp: number;}

interface IConsoleDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'console';
    level: TConsoleMessageType;
    text: string;
}

interface IRequestDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'request';
    url: string;
    method: string;
    resourceType: string;
    isNavigationRequest: boolean;
}

interface IResponseDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'response';
    url: string;
    status: number;
    ok: boolean;
    fromCache: boolean;
    fromServiceWorker: boolean;
    resourceType: string;
    method: string;
}

interface IRequestFailedDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'requestfailed';
    url: string;
    method: string;
    resourceType: string;
    failureText: string;
}

interface IPageErrorDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'pageerror';
    text: string;
}

interface IErrorDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'error';
    text: string;
}

export type TDevtoolsEvent =
    | IConsoleDevtoolsEvent
    | IRequestDevtoolsEvent
    | IResponseDevtoolsEvent
    | IRequestFailedDevtoolsEvent
    | IPageErrorDevtoolsEvent
    | IErrorDevtoolsEvent;

export interface ISessionState {
    browser: Browser;
    page: Page;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    consoleMessages: IConsoleMessage[];
    devtoolsEvents: TDevtoolsEvent[];
}

export interface ISessionInfo {
    port: number;
    pid: number;
    cdpPort: number;
    electronPid: number | null;
    nuxtPid: number | null;
    nuxtPort: number;
}

export interface ISessionStartingInfo {
    pid: number;
    startedAt: number;
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

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            const { port } = addr;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export function getPidsOnPort(port: number): number[] {
    try {
        const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' });
        return output
            .split('\n')
            .map(entry => Number(entry.trim()))
            .filter(pid => Number.isFinite(pid) && pid > 0);
    } catch {
        return [];
    }
}

export function killPids(
    pids: number[],
    options: {
        signal?: NodeJS.Signals | number;
        exclude?: Set<number>;
    } = {},
): void {
    if (!Array.isArray(pids) || pids.length === 0) {
        return;
    }
    const signal = options.signal ?? 'SIGKILL';
    const exclude = options.exclude ?? new Set<number>();
    exclude.add(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
        exclude.add(process.ppid);
    }

    const uniquePids = uniq(pids);
    for (const pid of uniquePids) {
        if (exclude.has(pid)) {
            continue;
        }
        try {
            process.kill(pid, signal);
        } catch {}
    }
}

function collectDescendantPidsUnix(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0) {
        return [];
    }

    try {
        const output = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
        const childrenByParent = new Map<number, number[]>();

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const parts = trimmed.split(/\s+/);
            const pid = Number(parts[0]);
            const ppid = Number(parts[1]);
            if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid <= 0) {
                continue;
            }
            const bucket = childrenByParent.get(ppid) ?? [];
            bucket.push(pid);
            childrenByParent.set(ppid, bucket);
        }

        const descendants: number[] = [];
        const stack = [rootPid];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const children = childrenByParent.get(current) ?? [];
            for (const childPid of children) {
                descendants.push(childPid);
                stack.push(childPid);
            }
        }

        return descendants;
    } catch {
        return [];
    }
}

export function findPidsByCommandSubstring(substring: string) {
    const needle = substring.trim();
    if (!needle) {
        return [];
    }

    if (process.platform === 'win32') {
        return [];
    }

    try {
        const output = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
        const pids: number[] = [];
        for (const line of output.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            const command = match[2];
            if (!Number.isFinite(pid) || pid <= 0) {
                continue;
            }
            if (!command) {
                continue;
            }
            if (command.includes(needle)) {
                pids.push(pid);
            }
        }
        return pids;
    } catch {
        return [];
    }
}

export async function killProcessTree(pid: number, graceMs = 1500): Promise<void> {
    if (!Number.isFinite(pid) || pid <= 0) {
        return;
    }
    if (!isProcessAlive(pid)) {
        return;
    }

    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /PID ${pid} /T /F >NUL 2>&1`);
        } catch {}
        return;
    }

    const descendants = collectDescendantPidsUnix(pid);
    const targets = uniq([
        ...descendants,
        pid,
    ]);
    killPids(targets, { signal: 'SIGTERM' });

    if (graceMs > 0) {
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
            const alive = targets.some(targetPid => isProcessAlive(targetPid));
            if (!alive) {
                return;
            }
            await delay(80);
        }
    }

    const remaining = targets.filter(targetPid => isProcessAlive(targetPid));
    if (remaining.length > 0) {
        killPids(remaining, { signal: 'SIGKILL' });
    }
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

export function isProcessAlive(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
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
