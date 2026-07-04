import { randomBytes } from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import {
    appendFile,
    mkdir,
    open,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { app } from 'electron';
import type {
    IAgentAssistantChatMessage,
    IAgentAssistantChatScope,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    type IAssistantSessionScopeBinding,
    type TAssistantTurnOwnerState,
    isAssistantTurnActive,
} from '@electron/features/agent/assistantTurnLifecycle';

const ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION = 1;
const ASSISTANT_CHAT_STORAGE_DIR = 'assistant-chat';
const ASSISTANT_CHAT_SESSION_DIR = 'sessions';
const ASSISTANT_CHAT_ARCHIVE_DIR = 'archive';
const DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS = 64;
const ASSISTANT_CHAT_INTERRUPTED_ERROR = 'Assistant turn interrupted because EVB Viewer closed before it completed.';

const logger = createLogger('assistant-chat-persistence');

interface IPersistedAssistantChatSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    scopeBinding: IAssistantSessionScopeBinding | null;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    lastError?: string;
}

interface IAssistantChatPersistenceSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    scopeBinding: IAssistantSessionScopeBinding | null;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    lastError?: string;
}

type TPersistedAssistantChatRecord =
    | {
        schemaVersion: typeof ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION;
        type: 'session-snapshot';
        key: string;
        writtenAt: string;
        session: IPersistedAssistantChatSession;
    }
    | {
        schemaVersion: typeof ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION;
        type: 'session-reset';
        key: string;
        writtenAt: string;
    };

export interface IRecoveredAssistantChatSession {
    key: string;
    session: IPersistedAssistantChatSession;
    filePath: string;
    sizeBytes: number;
}

export interface IAssistantChatPersistenceOptions {
    rootDir?: string;
    maxSessionBytes?: number;
    maxSessions?: number;
    now?: () => number;
    onError?: (message: string, error: unknown) => void;
}

function readBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum?: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function readAssistantChatMaxSessionBytes() {
    return readBoundedIntegerEnv(
        'EVB_ASSISTANT_CHAT_MAX_SESSION_BYTES',
        DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES,
        64 * 1024,
        128 * 1024 * 1024,
    );
}

function readAssistantChatMaxSessions() {
    return readBoundedIntegerEnv(
        'EVB_ASSISTANT_CHAT_MAX_SESSIONS',
        DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS,
        1,
        512,
    );
}

function getDefaultAssistantChatPersistenceRoot() {
    return join(app.getPath('userData'), ASSISTANT_CHAT_STORAGE_DIR);
}

function createPersistenceSessionFileName(sessionKey: string) {
    return `${Buffer.from(sessionKey, 'utf8').toString('base64url')}.jsonl`;
}

function decodePersistenceSessionFileName(fileName: string) {
    if (!fileName.endsWith('.jsonl')) {
        return null;
    }

    try {
        return Buffer.from(fileName.slice(0, -'.jsonl'.length), 'base64url').toString('utf8');
    } catch {
        return null;
    }
}

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

function safeCloseSync(fd: number | null) {
    if (fd === null) {
        return;
    }

    try {
        closeSync(fd);
    } catch {
        // best effort
    }
}

function fsyncParentDirectorySync(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let fd: number | null = null;
    try {
        fd = openSync(dirname(filePath), fsConstants.O_RDONLY);
        fsyncSyncBestEffort(fd);
    } catch {
        return;
    } finally {
        safeCloseSync(fd);
    }
}

function fsyncSyncBestEffort(fd: number) {
    try {
        fsyncSync(fd);
    } catch {
        // best effort
    }
}

async function fsyncParentDirectory(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(dirname(filePath), fsConstants.O_RDONLY);
        await handle.sync();
    } catch {
        return;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function atomicWriteJsonFile(filePath: string, payload: unknown) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const handle = await open(tempPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tempPath, filePath);
    await fsyncParentDirectory(filePath);
}

async function atomicWriteJsonLineFile(filePath: string, payload: unknown) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
    const handle = await open(tempPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tempPath, filePath);
    await fsyncParentDirectory(filePath);
}

function atomicWriteJsonFileSync(filePath: string, payload: unknown) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    let fd: number | null = null;
    try {
        fd = openSync(tempPath, 'r');
        fsyncSyncBestEffort(fd);
    } finally {
        safeCloseSync(fd);
    }
    renameSync(tempPath, filePath);
    fsyncParentDirectorySync(filePath);
}

function clonePersistedSession(session: IAssistantChatPersistenceSession): IPersistedAssistantChatSession {
    return {
        provider: session.provider,
        scope: {...session.scope},
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        providerThreadId: session.providerThreadId,
        lastSenderWindowId: session.lastSenderWindowId,
        turnOwner: {...session.turnOwner},
        scopeBinding: session.scopeBinding ? {...session.scopeBinding} : null,
        messages: session.messages.map((message: IAgentAssistantChatMessage): IAgentAssistantChatMessage => {
            const attachments = message.attachments;
            return {
                ...message,
                ...(attachments === undefined
                    ? {}
                    : {attachments: attachments.map(attachment => ({...attachment}))}),
            };
        }),
        lastAccessedAtMs: session.lastAccessedAtMs,
        ...(session.lastError === undefined ? {} : { lastError: session.lastError }),
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPersistedSession(value: unknown): value is IPersistedAssistantChatSession {
    if (!isObject(value)) {
        return false;
    }
    return (value.provider === 'codex' || value.provider === 'claude')
        && isObject(value.scope)
        && value.scope.kind === 'document'
        && typeof value.scope.key === 'string'
        && typeof value.model === 'string'
        && typeof value.effort === 'string'
        && (value.speedMode === 'fast' || value.speedMode === 'standard')
        && (typeof value.providerThreadId === 'string' || value.providerThreadId === null)
        && (typeof value.lastSenderWindowId === 'number' || value.lastSenderWindowId === null)
        && isObject(value.turnOwner)
        && Array.isArray(value.messages)
        && typeof value.lastAccessedAtMs === 'number';
}

function parsePersistedRecord(line: string): TPersistedAssistantChatRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }

    if (!isObject(parsed) || parsed.schemaVersion !== ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION) {
        return null;
    }
    if (parsed.type === 'session-reset' && typeof parsed.key === 'string') {
        return parsed as TPersistedAssistantChatRecord;
    }
    if (
        parsed.type === 'session-snapshot'
        && typeof parsed.key === 'string'
        && isPersistedSession(parsed.session)
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    return null;
}

function interruptRecoveredSession(session: IPersistedAssistantChatSession): IPersistedAssistantChatSession {
    if (!isAssistantTurnActive(session.turnOwner)) {
        return session;
    }

    session.turnOwner = {
        phase: 'error',
        generation: session.turnOwner.generation,
        turnId: null,
        localTurnId: null,
        error: ASSISTANT_CHAT_INTERRUPTED_ERROR,
    };
    session.scopeBinding = null;
    session.lastError = ASSISTANT_CHAT_INTERRUPTED_ERROR;
    for (const message of session.messages) {
        if (message.role === 'assistant' && message.pending) {
            message.pending = false;
            message.error = message.error ?? ASSISTANT_CHAT_INTERRUPTED_ERROR;
        }
    }
    return session;
}

function createSnapshotRecord(key: string, session: IAssistantChatPersistenceSession): TPersistedAssistantChatRecord {
    return {
        schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
        type: 'session-snapshot',
        key,
        writtenAt: new Date().toISOString(),
        session: clonePersistedSession(session),
    };
}

function createPersistedSnapshotRecord(
    key: string,
    session: IPersistedAssistantChatSession,
): TPersistedAssistantChatRecord {
    return {
        schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
        type: 'session-snapshot',
        key,
        writtenAt: new Date().toISOString(),
        session,
    };
}

export class AssistantChatPersistence {
    readonly rootDir: string;
    readonly sessionsDir: string;
    readonly archiveDir: string;
    readonly indexPath: string;
    private readonly maxSessionBytes: number;
    private readonly maxSessions: number;
    private readonly now: () => number;
    private readonly onError: (message: string, error: unknown) => void;
    private readonly queues = new Map<string, Promise<void>>();

    constructor(options: IAssistantChatPersistenceOptions = {}) {
        this.rootDir = options.rootDir ?? getDefaultAssistantChatPersistenceRoot();
        this.sessionsDir = join(this.rootDir, ASSISTANT_CHAT_SESSION_DIR);
        this.archiveDir = join(this.rootDir, ASSISTANT_CHAT_ARCHIVE_DIR);
        this.indexPath = join(this.rootDir, 'index.json');
        this.maxSessionBytes = options.maxSessionBytes ?? readAssistantChatMaxSessionBytes();
        this.maxSessions = options.maxSessions ?? readAssistantChatMaxSessions();
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? ((message, error) => {
            logger.warn(`${message}: ${getErrorMessage(error)}`);
        });
        mkdirSync(this.sessionsDir, { recursive: true });
        mkdirSync(this.archiveDir, { recursive: true });
    }

    sessionPath(key: string): string {
        return join(this.sessionsDir, createPersistenceSessionFileName(key));
    }

    // fallow-ignore-next-line unused-class-member
    recoverSessions(): IRecoveredAssistantChatSession[] {
        const recovered: IRecoveredAssistantChatSession[] = [];
        if (!existsSync(this.sessionsDir)) {
            return recovered;
        }

        for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (!key) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            let lastSession: IPersistedAssistantChatSession | null = null;
            let resetAfterSnapshot = false;
            try {
                for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
                    const line = rawLine.trim();
                    if (!line) {
                        continue;
                    }
                    const record = parsePersistedRecord(line);
                    if (!record || record.key !== key) {
                        continue;
                    }
                    if (record.type === 'session-reset') {
                        lastSession = null;
                        resetAfterSnapshot = true;
                        continue;
                    }
                    lastSession = record.session;
                    resetAfterSnapshot = false;
                }
                if (!lastSession || resetAfterSnapshot) {
                    continue;
                }
                recovered.push({
                    key,
                    session: interruptRecoveredSession(lastSession),
                    filePath,
                    sizeBytes: statSync(filePath).size,
                });
            } catch (error) {
                this.onError(`Failed to recover assistant chat session "${key}"`, error);
            }
        }
        this.pruneRecoveredSessionsSync(recovered);
        return recovered;
    }

    recordSessionSnapshot(key: string, session: IAssistantChatPersistenceSession): void {
        const record = createSnapshotRecord(key, session);
        this.enqueue(key, async () => {
            await this.appendRecord(key, record);
            await this.writeIndex();
            await this.compactOversizedSession(key);
            await this.pruneSessions();
        });
    }

    // fallow-ignore-next-line unused-class-member
    recordTurnBoundary(key: string, session: IAssistantChatPersistenceSession): void {
        this.recordSessionSnapshot(key, session);
    }

    // fallow-ignore-next-line unused-class-member
    archiveSession(key: string, reason: string): void {
        this.enqueue(key, async () => {
            const sourcePath = this.sessionPath(key);
            if (!await this.pathExists(sourcePath)) {
                return;
            }
            await mkdir(this.archiveDir, { recursive: true });
            const archivedPath = join(
                this.archiveDir,
                `${basename(sourcePath, '.jsonl')}.${reason}.${this.now()}.jsonl`,
            );
            await rename(sourcePath, archivedPath);
            await fsyncParentDirectory(sourcePath);
            await this.writeIndex();
        });
    }

    // fallow-ignore-next-line unused-class-member
    removeSession(key: string): void {
        this.enqueue(key, async () => {
            await rm(this.sessionPath(key), { force: true });
            await this.writeIndex();
        });
    }

    // fallow-ignore-next-line unused-class-member
    flushForTests(): Promise<unknown[]> {
        return Promise.all([...this.queues.values()]);
    }

    private enqueue(key: string, task: () => Promise<void>): void {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(task).catch((error: unknown) => {
            this.onError(`Failed to persist assistant chat session "${key}"`, error);
        });
        this.queues.set(key, next);
        void next.finally(() => {
            if (this.queues.get(key) === next) {
                this.queues.delete(key);
            }
        });
    }

    private async appendRecord(key: string, record: TPersistedAssistantChatRecord) {
        await mkdir(this.sessionsDir, { recursive: true });
        const filePath = this.sessionPath(key);
        await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
        const handle = await open(filePath, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    private async compactOversizedSession(key: string) {
        const filePath = this.sessionPath(key);
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
            fileStat = await stat(filePath);
        } catch {
            return;
        }
        if (fileStat.size <= this.maxSessionBytes) {
            return;
        }

        const recovered = this.recoverSessionFile(key, filePath);
        if (!recovered) {
            await rm(filePath, { force: true });
            return;
        }
        await atomicWriteJsonLineFile(filePath, createPersistedSnapshotRecord(key, recovered));
    }

    private recoverSessionFile(key: string, filePath: string) {
        let lastSession: IPersistedAssistantChatSession | null = null;
        for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const record = parsePersistedRecord(line);
            if (record?.type === 'session-snapshot' && record.key === key) {
                lastSession = record.session;
            }
            if (record?.type === 'session-reset' && record.key === key) {
                lastSession = null;
            }
        }
        return lastSession;
    }

    private async pruneSessions() {
        let entries = await this.readSessionEntries();
        if (entries.length <= this.maxSessions) {
            return;
        }
        entries = entries.sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs);
        const removeCount = entries.length - this.maxSessions;
        for (const entry of entries.slice(0, removeCount)) {
            await rm(entry.filePath, { force: true });
        }
        await this.writeIndex();
    }

    private pruneRecoveredSessionsSync(recovered: IRecoveredAssistantChatSession[]) {
        if (recovered.length <= this.maxSessions) {
            return;
        }
        const removable = [...recovered].sort((left, right) => left.session.lastAccessedAtMs - right.session.lastAccessedAtMs);
        for (const entry of removable.slice(0, recovered.length - this.maxSessions)) {
            try {
                unlinkSync(entry.filePath);
                recovered.splice(recovered.indexOf(entry), 1);
            } catch (error) {
                this.onError(`Failed to prune recovered assistant chat session "${entry.key}"`, error);
            }
        }
        this.writeIndexSync();
    }

    private async readSessionEntries() {
        const entries: Array<{
            filePath: string;
            key: string;
            lastAccessedAtMs: number;
            sizeBytes: number;
        }> = [];
        for (const entry of await readdir(this.sessionsDir, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (!key) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            const recovered = this.recoverSessionFile(key, filePath);
            const fileStat = await stat(filePath).catch(() => null);
            if (!recovered || !fileStat) {
                continue;
            }
            entries.push({
                filePath,
                key,
                lastAccessedAtMs: recovered.lastAccessedAtMs,
                sizeBytes: fileStat.size,
            });
        }
        return entries;
    }

    private async writeIndex() {
        await atomicWriteJsonFile(this.indexPath, {
            schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
            sessions: (await this.readSessionEntries()).map(entry => ({
                key: entry.key,
                file: basename(entry.filePath),
                lastAccessedAtMs: entry.lastAccessedAtMs,
                sizeBytes: entry.sizeBytes,
            })),
        });
    }

    private writeIndexSync() {
        const sessions: Array<{
            key: string;
            file: string;
            lastAccessedAtMs: number;
            sizeBytes: number;
        }> = [];
        for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (!key) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            const recovered = this.recoverSessionFile(key, filePath);
            if (!recovered) {
                continue;
            }
            sessions.push({
                key,
                file: entry.name,
                lastAccessedAtMs: recovered.lastAccessedAtMs,
                sizeBytes: statSync(filePath).size,
            });
        }
        atomicWriteJsonFileSync(this.indexPath, {
            schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
            sessions,
        });
    }

    private async pathExists(filePath: string) {
        try {
            await stat(filePath);
            return true;
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }
}
