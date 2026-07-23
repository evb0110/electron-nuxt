import {
    createHash,
    randomBytes,
} from 'node:crypto';
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
    TAgentWorkspaceCommandTarget,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
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
const ASSISTANT_CHAT_SESSION_FILE_PREFIX = 'v2-';
const DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS = 64;
const DEFAULT_ASSISTANT_CHAT_SNAPSHOT_DEBOUNCE_MS = 300;
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

interface IRecoveredAssistantChatSessionFile {
    key: string;
    session: IPersistedAssistantChatSession;
}

export interface IAssistantChatPersistenceOptions {
    rootDir?: string;
    maxSessionBytes?: number;
    maxSessions?: number;
    snapshotDebounceMs?: number;
    now?: () => number;
    onError?: (message: string, error: unknown) => void;
}

interface IPendingAssistantChatSnapshot {
    ready: boolean;
    record: TPersistedAssistantChatRecord;
    timer: ReturnType<typeof setTimeout> | null;
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
    const digest = createHash('sha256').update(sessionKey).digest('hex');
    return `${ASSISTANT_CHAT_SESSION_FILE_PREFIX}${digest}.jsonl`;
}

function decodePersistenceSessionFileName(fileName: string) {
    if (!fileName.endsWith('.jsonl')) {
        return null;
    }
    if (fileName.startsWith(ASSISTANT_CHAT_SESSION_FILE_PREFIX)) {
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

function atomicWriteJsonLineFileSync(filePath: string, payload: unknown) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
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

function isNonNegativeInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNullableString(value: unknown) {
    return value === null || typeof value === 'string';
}

function isOptionalNullableString(value: unknown) {
    return value === undefined || isNullableString(value);
}

function isOptionalDocumentBackend(value: unknown) {
    return value === undefined || value === 'electron' || value === 'browser';
}

function isWorkspaceCommandTarget(value: unknown): value is TAgentWorkspaceCommandTarget {
    if (
        !isObject(value)
        || typeof value.tabId !== 'string'
        || value.tabId.length === 0
        || typeof value.sessionId !== 'string'
        || value.sessionId.length === 0
        || !isNullableString(value.documentRef)
        || !isOptionalDocumentBackend(value.documentBackend)
        || !isOptionalNullableString(value.documentInstanceId)
        || (
            value.documentRevisionToken !== undefined
            && (typeof value.documentRevisionToken !== 'string' || value.documentRevisionToken.length === 0)
        )
    ) {
        return false;
    }
    return value.kind === 'transaction'
        ? typeof value.transactionId === 'string' && value.transactionId.length > 0
        : value.kind === 'revision' && isNonNegativeInteger(value.sessionRevision);
}

function isAssistantChatScope(value: unknown): value is IAgentAssistantChatScope {
    return isObject(value)
        && value.kind === 'document'
        && typeof value.key === 'string'
        && value.key.length > 0
        && isNullableString(value.title)
        && isOptionalNullableString(value.tabId)
        && isOptionalNullableString(value.documentSessionKey)
        && isOptionalNullableString(value.documentInstanceId)
        && isOptionalNullableString(value.documentRef)
        && isOptionalDocumentBackend(value.documentBackend)
        && (
            value.documentIdentity === undefined
            || value.documentIdentity === null
            || isDocumentRevisionInfo(value.documentIdentity)
        )
        && (
            value.commandTarget === undefined
            || isWorkspaceCommandTarget(value.commandTarget)
        );
}

function isAssistantErrorEnvelope(value: unknown) {
    return isObject(value)
        && (
            value.code === 'AUTH_REQUIRED'
            || value.code === 'INSTALL_MISSING'
            || value.code === 'LOGIN_CANCELLED'
            || value.code === 'USER_INTERRUPTED'
            || value.code === 'MODEL_UNAVAILABLE'
            || value.code === 'RUNTIME_UNAVAILABLE'
            || value.code === 'PROVIDER_RATE_LIMITED'
            || value.code === 'INTERNAL'
        )
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean'
        && typeof value.timestamp === 'number'
        && Number.isFinite(value.timestamp);
}

function isAssistantImageAttachment(value: unknown) {
    return isObject(value)
        && value.type === 'image'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && typeof value.mimeType === 'string'
        && typeof value.dataUrl === 'string'
        && typeof value.sizeBytes === 'number'
        && Number.isFinite(value.sizeBytes)
        && value.sizeBytes > 0;
}

function isAssistantChatMessage(value: unknown): value is IAgentAssistantChatMessage {
    return isObject(value)
        && typeof value.id === 'string'
        && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
        && typeof value.text === 'string'
        && typeof value.createdAt === 'string'
        && (
            value.attachments === undefined
            || Array.isArray(value.attachments) && value.attachments.every(isAssistantImageAttachment)
        )
        && (value.pending === undefined || typeof value.pending === 'boolean')
        && (value.error === undefined || typeof value.error === 'string')
        && (value.errorEnvelope === undefined || isAssistantErrorEnvelope(value.errorEnvelope));
}

function isAssistantSessionScopeBinding(value: unknown): value is IAssistantSessionScopeBinding {
    return isObject(value)
        && typeof value.sessionKey === 'string'
        && value.sessionKey.length > 0
        && typeof value.scopeKey === 'string'
        && value.scopeKey.length > 0
        && (value.provider === 'codex' || value.provider === 'claude')
        && isNonNegativeInteger(value.turnGeneration)
        && isSafeInteger(value.windowId)
        && typeof value.tabId === 'string'
        && isOptionalNullableString(value.documentSessionKey)
        && isNullableString(value.documentRef)
        && isOptionalDocumentBackend(value.documentBackend)
        && isOptionalNullableString(value.documentInstanceId)
        && (value.documentIdentity === null || isDocumentRevisionInfo(value.documentIdentity))
        && (value.commandTarget === undefined || isWorkspaceCommandTarget(value.commandTarget));
}

function isAssistantTurnOwner(value: unknown): value is TAssistantTurnOwnerState {
    if (!isObject(value) || !isNonNegativeInteger(value.generation)) {
        return false;
    }
    if (value.phase === 'idle') {
        return value.turnId === null && value.localTurnId === null;
    }
    if (value.phase === 'error') {
        return value.turnId === null
            && value.localTurnId === null
            && typeof value.error === 'string';
    }
    if (value.phase === 'starting') {
        return typeof value.localTurnId === 'string'
            && value.providerTurnId === null
            && isAssistantSessionScopeBinding(value.scope)
            && value.scope.turnGeneration === value.generation;
    }
    if (value.phase === 'running' || value.phase === 'interrupting') {
        return typeof value.localTurnId === 'string'
            && (
                value.phase === 'interrupting' && value.providerTurnId === null
                || typeof value.providerTurnId === 'string'
            )
            && isAssistantSessionScopeBinding(value.scope)
            && value.scope.turnGeneration === value.generation;
    }
    return false;
}

function isPersistedSession(value: unknown): value is IPersistedAssistantChatSession {
    if (!isObject(value)) {
        return false;
    }
    return (value.provider === 'codex' || value.provider === 'claude')
        && isAssistantChatScope(value.scope)
        && typeof value.model === 'string'
        && typeof value.effort === 'string'
        && (value.speedMode === 'fast' || value.speedMode === 'standard')
        && (typeof value.providerThreadId === 'string' || value.providerThreadId === null)
        && (isNonNegativeInteger(value.lastSenderWindowId) || value.lastSenderWindowId === null)
        && isAssistantTurnOwner(value.turnOwner)
        && (value.scopeBinding === null || isAssistantSessionScopeBinding(value.scopeBinding))
        && Array.isArray(value.messages)
        && value.messages.every(isAssistantChatMessage)
        && typeof value.lastAccessedAtMs === 'number'
        && Number.isFinite(value.lastAccessedAtMs)
        && (value.lastError === undefined || typeof value.lastError === 'string');
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
    if (
        parsed.type === 'session-reset'
        && typeof parsed.key === 'string'
        && parsed.key.length > 0
        && typeof parsed.writtenAt === 'string'
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    if (
        parsed.type === 'session-snapshot'
        && typeof parsed.key === 'string'
        && parsed.key.length > 0
        && typeof parsed.writtenAt === 'string'
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
    private readonly snapshotDebounceMs: number;
    private readonly now: () => number;
    private readonly onError: (message: string, error: unknown) => void;
    private readonly queues = new Map<string, Promise<void>>();
    private readonly pendingSnapshots = new Map<string, IPendingAssistantChatSnapshot>();
    private readonly activeSnapshotCounts = new Map<string, number>();
    private writeQueue: Promise<void> = Promise.resolve();
    private maintenanceQueue: Promise<void> = Promise.resolve();

    constructor(options: IAssistantChatPersistenceOptions = {}) {
        this.rootDir = options.rootDir ?? getDefaultAssistantChatPersistenceRoot();
        this.sessionsDir = join(this.rootDir, ASSISTANT_CHAT_SESSION_DIR);
        this.archiveDir = join(this.rootDir, ASSISTANT_CHAT_ARCHIVE_DIR);
        this.indexPath = join(this.rootDir, 'index.json');
        this.maxSessionBytes = options.maxSessionBytes ?? readAssistantChatMaxSessionBytes();
        this.maxSessions = options.maxSessions ?? readAssistantChatMaxSessions();
        this.snapshotDebounceMs = options.snapshotDebounceMs ?? DEFAULT_ASSISTANT_CHAT_SNAPSHOT_DEBOUNCE_MS;
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
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            try {
                const recoveredFile = this.recoverSessionFile(filePath, key ?? undefined);
                if (!recoveredFile) {
                    continue;
                }
                recovered.push({
                    key: recoveredFile.key,
                    session: interruptRecoveredSession(recoveredFile.session),
                    filePath,
                    sizeBytes: statSync(filePath).size,
                });
            } catch (error) {
                try {
                    this.quarantineCorruptSessionSync(filePath);
                } catch (quarantineError) {
                    this.onError(`Failed to quarantine corrupt assistant chat session "${key ?? entry.name}"`, quarantineError);
                }
                this.onError(`Failed to recover assistant chat session "${key ?? entry.name}"`, error);
            }
        }
        this.pruneRecoveredSessionsSync(recovered);
        return recovered;
    }

    // fallow-ignore-next-line unused-class-member
    recordSessionSnapshot(key: string, session: IAssistantChatPersistenceSession): void {
        this.setPendingSnapshot(key, createSnapshotRecord(key, session), false);
    }

    // fallow-ignore-next-line unused-class-member
    recordTurnBoundary(key: string, session: IAssistantChatPersistenceSession): void {
        this.setPendingSnapshot(key, createSnapshotRecord(key, session), true);
    }

    // fallow-ignore-next-line unused-class-member
    archiveSession(key: string, reason: string): void {
        this.enqueueAfterSnapshots(key, async () => {
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
            await this.runMaintenance(() => this.writeIndex());
        });
    }

    // fallow-ignore-next-line unused-class-member
    removeSession(key: string): void {
        this.enqueueAfterSnapshots(key, async () => {
            await rm(this.sessionPath(key), { force: true });
            await this.runMaintenance(() => this.writeIndex());
        });
    }

    // fallow-ignore-next-line unused-class-member
    flushForTests(): Promise<unknown[]> {
        return this.flushUntilIdle();
    }

    // fallow-ignore-next-line unused-class-member
    flush(): Promise<unknown[]> {
        return this.flushUntilIdle();
    }

    private enqueue(key: string, task: () => Promise<void>): void {
        const previous = this.writeQueue;
        const next = previous.catch(() => undefined).then(task).catch((error: unknown) => {
            this.onError(`Failed to persist assistant chat session "${key}"`, error);
        });
        this.writeQueue = next.catch(() => undefined);
        this.queues.set(key, next);
        void next.finally(() => {
            if (this.queues.get(key) === next) {
                this.queues.delete(key);
            }
        });
    }

    private setPendingSnapshot(key: string, record: TPersistedAssistantChatRecord, durable: boolean) {
        const existing = this.pendingSnapshots.get(key);
        if (existing?.timer) {
            clearTimeout(existing.timer);
        }
        const pending = existing ?? {
            ready: false,
            record,
            timer: null,
        };
        pending.record = record;
        pending.timer = null;
        if (durable || pending.ready) {
            pending.ready = true;
            this.pendingSnapshots.set(key, pending);
            this.schedulePendingSnapshot(key);
            return;
        }
        pending.timer = setTimeout(() => {
            pending.timer = null;
            pending.ready = true;
            this.schedulePendingSnapshot(key);
        }, this.snapshotDebounceMs);
        pending.timer.unref?.();
        this.pendingSnapshots.set(key, pending);
    }

    private forcePendingSnapshot(key: string, allowConcurrent = false) {
        const pending = this.pendingSnapshots.get(key);
        if (!pending) {
            return;
        }
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }
        pending.ready = true;
        this.schedulePendingSnapshot(key, allowConcurrent);
    }

    private schedulePendingSnapshot(key: string, allowConcurrent = false) {
        const pending = this.pendingSnapshots.get(key);
        const activeCount = this.activeSnapshotCounts.get(key) ?? 0;
        if (!pending?.ready || activeCount > 0 && !allowConcurrent) {
            return;
        }
        this.pendingSnapshots.delete(key);
        this.activeSnapshotCounts.set(key, activeCount + 1);
        this.enqueue(key, async () => {
            await this.appendRecord(key, pending.record);
            await this.runMaintenance(async () => {
                await this.compactOversizedSession(key);
                await this.pruneSessions();
                await this.writeIndex();
            });
        });
        const activeWrite = this.queues.get(key);
        void activeWrite?.finally(() => {
            const remaining = (this.activeSnapshotCounts.get(key) ?? 1) - 1;
            if (remaining === 0) {
                this.activeSnapshotCounts.delete(key);
            } else {
                this.activeSnapshotCounts.set(key, remaining);
            }
            this.schedulePendingSnapshot(key);
        });
    }

    private enqueueAfterSnapshots(key: string, task: () => Promise<void>) {
        this.forcePendingSnapshot(key, true);
        this.enqueue(key, task);
    }

    private async runMaintenance(task: () => Promise<void>) {
        const next = this.maintenanceQueue.catch(() => undefined).then(task);
        this.maintenanceQueue = next.catch(() => undefined);
        await next;
    }

    private async flushUntilIdle() {
        const results: unknown[] = [];
        for (;;) {
            for (const key of this.pendingSnapshots.keys()) {
                this.forcePendingSnapshot(key);
            }
            const pending = [
                ...this.queues.values(),
                this.writeQueue,
                this.maintenanceQueue,
            ];
            await Promise.all(pending).then(values => {
                results.push(...values);
            });
            if (
                this.queues.size === 0
                && this.pendingSnapshots.size === 0
                && this.activeSnapshotCounts.size === 0
            ) {
                await this.writeQueue;
                await this.maintenanceQueue;
                if (
                    this.queues.size === 0
                    && this.pendingSnapshots.size === 0
                    && this.activeSnapshotCounts.size === 0
                ) {
                    return results;
                }
            }
        }
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

        let recovered: IRecoveredAssistantChatSessionFile | null;
        try {
            recovered = this.recoverSessionFile(filePath, key);
        } catch (error) {
            this.quarantineCorruptSessionSync(filePath);
            this.onError(`Quarantined corrupt assistant chat session "${key}" during compaction`, error);
            return;
        }
        if (!recovered) {
            await rm(filePath, { force: true });
            return;
        }
        await atomicWriteJsonLineFile(filePath, createPersistedSnapshotRecord(key, recovered.session));
    }

    private recoverSessionFile(filePath: string, expectedKey?: string): IRecoveredAssistantChatSessionFile | null {
        let key: string | null = null;
        let lastSession: IPersistedAssistantChatSession | null = null;
        const contents = readFileSync(filePath, 'utf8');
        const lines = contents.split(/\r?\n/u);
        for (const [
            lineIndex,
            rawLine,
        ] of lines.entries()) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const record = parsePersistedRecord(line);
            if (!record) {
                if (
                    lineIndex === lines.length - 1
                    && !contents.endsWith('\n')
                    && key !== null
                    && lastSession !== null
                ) {
                    atomicWriteJsonLineFileSync(
                        filePath,
                        createPersistedSnapshotRecord(key, lastSession),
                    );
                    break;
                }
                throw new Error('Assistant chat transcript contains a malformed persisted record.');
            }
            if (
                (expectedKey !== undefined && record.key !== expectedKey)
                || (key !== null && record.key !== key)
            ) {
                throw new Error('Assistant chat transcript contains records for different session keys.');
            }
            key = record.key;
            if (record.type === 'session-snapshot') {
                lastSession = record.session;
            }
            if (record.type === 'session-reset') {
                lastSession = null;
            }
        }
        return key && lastSession
            ? {
                key,
                session: lastSession,
            }
            : null;
    }

    private quarantineCorruptSessionSync(filePath: string) {
        if (!existsSync(filePath)) {
            return;
        }
        mkdirSync(this.archiveDir, {recursive: true});
        const archivedPath = join(
            this.archiveDir,
            `${basename(filePath, '.jsonl')}.corrupt.${this.now()}.${randomSuffix()}.jsonl`,
        );
        renameSync(filePath, archivedPath);
        fsyncParentDirectorySync(filePath);
        fsyncParentDirectorySync(archivedPath);
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
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            let recovered: IRecoveredAssistantChatSessionFile | null;
            try {
                recovered = this.recoverSessionFile(filePath, key ?? undefined);
            } catch (error) {
                this.quarantineCorruptSessionSync(filePath);
                this.onError(`Quarantined corrupt assistant chat session "${key ?? entry.name}" during maintenance`, error);
                continue;
            }
            const fileStat = await stat(filePath).catch(() => null);
            if (!recovered || !fileStat) {
                continue;
            }
            entries.push({
                filePath,
                key: recovered.key,
                lastAccessedAtMs: recovered.session.lastAccessedAtMs,
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
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            const recovered = this.recoverSessionFile(filePath, key ?? undefined);
            if (!recovered) {
                continue;
            }
            sessions.push({
                key: recovered.key,
                file: entry.name,
                lastAccessedAtMs: recovered.session.lastAccessedAtMs,
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
