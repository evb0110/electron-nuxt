import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    requireDocumentInstanceId,
    type TDocumentInstanceId,
} from '@contracts/documentInstanceId';
import type { TTabUpdate } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    areWorkspaceDocumentRecordsEqual,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
    type TWorkspaceDocumentTabState,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSessionController,
    IWorkspaceDocumentSessionSnapshot,
    IWorkspaceDocumentTransaction,
    TWorkspaceDocumentSessionPhase,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

interface ICreateWorkspaceDocumentSessionCoreOptions {
    tabId: string;
    sessionId?: string;
    initialRecord?: IWorkspaceDocumentRecord | null;
    initialTab?: TTabUpdate | TWorkspaceDocumentTabState | null;
    initialViewState?: ITabViewSessionState | null;
    now?: () => number;
    createSessionId?: (tabId: string) => string;
    createTransactionId?: (input: {
        tabId: string;
        kind: TWorkspaceDocumentTransactionKind;
        nextTransactionIndex: number;
    }) => string;
    createDocumentSessionKey?: (input: {
        tabId: string;
        nextDocumentSessionIndex: number;
        documentRef: string | null;
    }) => string;
    createDocumentInstanceId?: () => TDocumentInstanceId;
    workspaceWaitTimeoutMs?: number;
}

interface IWorkspaceWaiter {
    target: TWorkspaceCommandTarget;
    resolve: (workspace: IWorkspaceExpose | null) => void;
    timer: ReturnType<typeof setTimeout>;
}

// Large documents can legitimately take well over four seconds to mount their
// workspace host on production hardware. Keep this aligned with the document
// visual-settle policies so routing does not manufacture a false open failure.
const DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS = 30_000;
let nextSessionIndex = 0;
let nextGlobalDocumentSessionKeyIndex = 0;

function createDefaultSessionId(tabId: string) {
    nextSessionIndex += 1;
    return `workspace-document-session:${tabId}:${Date.now()}:${nextSessionIndex}`;
}

function createDefaultTransactionId(input: {
    tabId: string;
    kind: TWorkspaceDocumentTransactionKind;
    nextTransactionIndex: number;
}) {
    return `workspace-document-transaction:${input.tabId}:${input.kind}:${Date.now()}:${input.nextTransactionIndex}`;
}

function createDefaultDocumentSessionKey(input: {
    tabId: string;
    nextDocumentSessionIndex: number;
    documentRef: string | null;
}) {
    nextGlobalDocumentSessionKeyIndex += 1;
    return [
        'workspace-document-instance',
        input.tabId,
        Date.now(),
        input.nextDocumentSessionIndex,
        nextGlobalDocumentSessionKeyIndex,
        input.documentRef ?? 'unknown',
    ].join(':');
}

function createDefaultDocumentInstanceId() {
    return requireDocumentInstanceId(crypto.randomUUID());
}

function createEmptyIdentity(): IWorkspaceDocumentIdentity {
    return {
        documentSessionKey: null,
        documentInstanceId: null,
        documentRef: null,
        originalPath: null,
        workingCopyPath: null,
        fileName: null,
        isDjvu: false,
        revisionInfo: null,
    };
}

function getLogicalDocumentSignature(identity: IWorkspaceDocumentIdentity) {
    const sourceRef = identity.originalPath
        ?? identity.revisionInfo?.documentRef
        ?? identity.documentRef
        ?? identity.workingCopyPath
        ?? null;
    if (!sourceRef && !identity.fileName && !identity.isDjvu) {
        return null;
    }
    return JSON.stringify({
        sourceRef,
        fallbackName: sourceRef ? null : identity.fileName,
        isDjvu: identity.isDjvu,
    });
}

function normalizeIdentityFromRecord(
    record: IWorkspaceDocumentRecord,
    previous: IWorkspaceDocumentIdentity,
    createDocumentSessionKey: (documentRef: string | null) => string,
    createDocumentInstanceId: () => TDocumentInstanceId,
    activeTransactionKind: TWorkspaceDocumentTransactionKind | null = null,
): IWorkspaceDocumentIdentity {
    const revisionInfo = record.documentIdentity;
    const hasDocument = revisionInfo !== null
        || record.tab.originalPath !== null
        || record.tab.fileName !== null
        || record.tab.isDjvu;

    if (!hasDocument) {
        return createEmptyIdentity();
    }

    const nextIdentity = {
        documentSessionKey: null,
        documentInstanceId: null,
        documentRef: revisionInfo?.documentRef ?? record.tab.originalPath ?? previous.documentRef,
        originalPath: record.tab.originalPath ?? null,
        workingCopyPath: revisionInfo?.documentRef ?? previous.workingCopyPath,
        fileName: record.tab.fileName ?? null,
        isDjvu: record.tab.isDjvu,
        revisionInfo,
    } satisfies IWorkspaceDocumentIdentity;
    const previousSignature = getLogicalDocumentSignature(previous);
    const nextSignature = getLogicalDocumentSignature(nextIdentity);
    const shouldPreserveLogicalIdentity = previous.documentSessionKey && previousSignature === nextSignature;
    const shouldMintDocumentInstance = (
        activeTransactionKind === 'open'
        || activeTransactionKind === 'restore'
        || activeTransactionKind === 'reload'
    )
        && !record.toolbarSnapshot.isOpeningDocument
        && !record.toolbarSnapshot.hasOpenError;
    const explicitDocumentInstanceId = record.tab.documentInstanceId ?? null;
    return {
        ...nextIdentity,
        documentSessionKey: shouldPreserveLogicalIdentity
            ? previous.documentSessionKey
            : createDocumentSessionKey(nextIdentity.documentRef),
        documentInstanceId: shouldMintDocumentInstance
            ? createDocumentInstanceId()
            : explicitDocumentInstanceId
                ?? (shouldPreserveLogicalIdentity ? previous.documentInstanceId : null)
                ?? createDocumentInstanceId(),
    };
}

function areIdentitiesEqual(
    first: IWorkspaceDocumentIdentity,
    second: IWorkspaceDocumentIdentity,
) {
    return first.documentSessionKey === second.documentSessionKey
        && first.documentInstanceId === second.documentInstanceId
        && first.documentRef === second.documentRef
        && first.originalPath === second.originalPath
        && first.workingCopyPath === second.workingCopyPath
        && first.fileName === second.fileName
        && first.isDjvu === second.isDjvu
        && first.revisionInfo?.token === second.revisionInfo?.token
        && first.revisionInfo?.documentRef === second.revisionInfo?.documentRef
        && first.revisionInfo?.contentRevision === second.revisionInfo?.contentRevision
        && first.revisionInfo?.authority === second.revisionInfo?.authority;
}

function createInitialRecord(options: ICreateWorkspaceDocumentSessionCoreOptions) {
    return options.initialRecord
        ? createWorkspaceDocumentRecord(options.initialRecord)
        : createWorkspaceDocumentRecord({
            tab: options.initialTab ?? undefined,
            viewState: options.initialViewState ?? undefined,
        });
}

function resolvePhaseFromRecord(
    record: IWorkspaceDocumentRecord,
    activeTransaction: IWorkspaceDocumentTransaction | null,
    previousPhase?: TWorkspaceDocumentSessionPhase,
): TWorkspaceDocumentSessionPhase {
    if (activeTransaction?.kind === 'close') {
        return 'closing';
    }

    if (record.toolbarSnapshot.hasOpenError) {
        return 'error';
    }

    if (record.toolbarSnapshot.isOpeningDocument) {
        return activeTransaction?.kind === 'restore' ? 'restoring' : 'opening';
    }

    if (previousPhase === 'error' && !activeTransaction && !record.toolbarSnapshot.initialVisualReady) {
        return 'error';
    }

    if (activeTransaction?.kind === 'reload') {
        return 'reloading';
    }

    if (
        record.toolbarSnapshot.initialVisualReady
        && hasWorkspaceViewerDocumentCapabilities(record.toolbarSnapshot.viewerCapabilities)
    ) {
        return 'ready';
    }

    return 'empty';
}

function resolvePhaseForTransaction(kind: TWorkspaceDocumentTransactionKind): TWorkspaceDocumentSessionPhase {
    if (kind === 'restore') {
        return 'restoring';
    }

    if (kind === 'reload') {
        return 'reloading';
    }

    if (kind === 'close') {
        return 'closing';
    }

    return 'opening';
}

function createSnapshotFromRecord(options: {
    tabId: string;
    sessionId: string;
    sessionRevision: number;
    record: IWorkspaceDocumentRecord;
    mounted: boolean;
    createDocumentSessionKey: (documentRef: string | null) => string;
    createDocumentInstanceId: () => TDocumentInstanceId;
}) {
    const identity = normalizeIdentityFromRecord(
        options.record,
        createEmptyIdentity(),
        options.createDocumentSessionKey,
        options.createDocumentInstanceId,
    );
    return {
        tabId: options.tabId,
        sessionId: options.sessionId,
        sessionRevision: options.sessionRevision,
        phase: resolvePhaseFromRecord(options.record, null),
        identity,
        activeTransaction: null,
        mounted: options.mounted,
        toolbarSnapshot: options.record.toolbarSnapshot,
        viewState: options.record.viewState,
        dirty: options.record.tab.isDirty,
        closeable: hasWorkspaceViewerDocumentCapabilities(options.record.toolbarSnapshot.viewerCapabilities),
        pendingDocumentPath: null,
        pendingClose: null,
    } satisfies IWorkspaceDocumentSessionSnapshot;
}

function areSessionSnapshotsEqual(
    first: IWorkspaceDocumentSessionSnapshot,
    second: IWorkspaceDocumentSessionSnapshot,
) {
    return JSON.stringify(first) === JSON.stringify(second);
}

function isDocumentRevisionTokenEqual(
    target: TWorkspaceCommandTarget,
    actual: IDocumentRevisionInfo | null,
) {
    if (target.documentRevisionToken === undefined) {
        return true;
    }

    return actual?.token === target.documentRevisionToken;
}

function getTargetDocumentRevisionToken(info: IDocumentRevisionInfo | null) {
    return info?.token === undefined ? {} : {documentRevisionToken: info.token};
}

function getTargetDocumentInstanceId(identity: IWorkspaceDocumentIdentity) {
    return {documentInstanceId: identity.documentInstanceId};
}

function getTargetDocumentBackend(documentRef: string | null) {
    const documentBackend = resolveDocumentRefBackend(documentRef);
    return documentBackend === undefined ? {} : {documentBackend};
}

export function createWorkspaceDocumentSessionCore(
    options: ICreateWorkspaceDocumentSessionCoreOptions,
): IWorkspaceDocumentSessionController {
    const now = options.now ?? Date.now;
    const sessionId = options.sessionId ?? options.createSessionId?.(options.tabId) ?? createDefaultSessionId(options.tabId);
    const workspaceWaitTimeoutMs = options.workspaceWaitTimeoutMs ?? DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS;
    const createDocumentInstanceId = options.createDocumentInstanceId ?? createDefaultDocumentInstanceId;
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
    let nextDocumentSessionIndex = 0;

    function createDocumentSessionKey(documentRef: string | null) {
        nextDocumentSessionIndex += 1;
        return options.createDocumentSessionKey?.({
            tabId: options.tabId,
            nextDocumentSessionIndex,
            documentRef,
        }) ?? createDefaultDocumentSessionKey({
            tabId: options.tabId,
            nextDocumentSessionIndex,
            documentRef,
        });
    }

    const initialRecord = createInitialRecord(options);
    const snapshot = ref<IWorkspaceDocumentSessionSnapshot>(createSnapshotFromRecord({
        tabId: options.tabId,
        sessionId,
        sessionRevision: 0,
        record: initialRecord,
        mounted: false,
        createDocumentSessionKey,
        createDocumentInstanceId,
    }));
    const waiters = new Set<IWorkspaceWaiter>();
    let nextTransactionIndex = 0;
    let closeRecordFenceActive = false;

    function updateSnapshot(
        updater: (current: IWorkspaceDocumentSessionSnapshot) => IWorkspaceDocumentSessionSnapshot,
        options: {incrementSessionRevision?: boolean} = {},
    ) {
        const current = snapshot.value;
        const next = updater(current);
        const nextSnapshot = {
            ...next,
            sessionRevision: options.incrementSessionRevision === true
                ? current.sessionRevision + 1
                : next.sessionRevision,
        };
        if (areSessionSnapshotsEqual(current, nextSnapshot)) {
            return false;
        }

        snapshot.value = nextSnapshot;
        rejectStaleWaiters();
        return true;
    }

    function resolveWaiter(waiter: IWorkspaceWaiter, workspace: IWorkspaceExpose | null) {
        if (!waiters.has(waiter)) {
            return;
        }

        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(validateCommandTarget(waiter.target).ok ? workspace : null);
    }

    function rejectStaleWaiters() {
        for (const waiter of [...waiters]) {
            if (!validateCommandTarget(waiter.target).ok) {
                resolveWaiter(waiter, null);
            }
        }
    }

    function resolveAllWaiters(workspace: IWorkspaceExpose | null) {
        for (const waiter of [...waiters]) {
            resolveWaiter(waiter, workspace);
        }
    }

    function beginTransaction(
        input: Omit<IWorkspaceDocumentTransaction, 'id' | 'tabId' | 'startedAt'>,
    ): IWorkspaceDocumentTransaction {
        const supersededTransaction = snapshot.value.activeTransaction;
        if (supersededTransaction) {
            finishTransaction(supersededTransaction.id, 'cancelled');
        }

        nextTransactionIndex += 1;
        const transaction: IWorkspaceDocumentTransaction = {
            ...input,
            id: options.createTransactionId?.({
                tabId: options.tabId,
                kind: input.kind,
                nextTransactionIndex,
            }) ?? createDefaultTransactionId({
                tabId: options.tabId,
                kind: input.kind,
                nextTransactionIndex,
            }),
            tabId: options.tabId,
            startedAt: now(),
        };
        if (transaction.kind !== 'close') {
            closeRecordFenceActive = false;
        } else {
            closeRecordFenceActive = true;
        }

        updateSnapshot(current => ({
            ...current,
            phase: resolvePhaseForTransaction(transaction.kind),
            activeTransaction: transaction,
            pendingDocumentPath: transaction.documentRef,
            pendingClose: transaction.kind === 'close'
                ? {
                    persist: transaction.persist ?? true,
                    target: {
                        kind: 'transaction',
                        tabId: options.tabId,
                        sessionId,
                        documentRef: transaction.documentRef,
                        ...getTargetDocumentBackend(transaction.documentRef),
                        ...getTargetDocumentInstanceId(current.identity),
                        transactionId: transaction.id,
                        ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
                    },
                }
                : null,
        }), {incrementSessionRevision: true});

        return transaction;
    }

    function finishTransaction(id: string, result: 'committed' | 'cancelled' | 'failed') {
        if (snapshot.value.activeTransaction?.id !== id) {
            return;
        }

        updateSnapshot((current) => {
            const record = createWorkspaceDocumentRecord({
                tab: {
                    fileName: current.identity.fileName,
                    originalPath: current.identity.originalPath,
                    documentInstanceId: current.identity.documentInstanceId,
                    isDirty: current.dirty,
                    isDjvu: current.identity.isDjvu,
                },
                documentIdentity: current.identity.revisionInfo,
                toolbarSnapshot: current.toolbarSnapshot,
                viewState: current.viewState,
            });
            return {
                ...current,
                phase: result === 'failed'
                    ? 'error'
                    : resolvePhaseFromRecord(record, null),
                activeTransaction: null,
                pendingDocumentPath: null,
                pendingClose: null,
            };
        }, {incrementSessionRevision: true});
    }

    function applyWorkspaceRecord(record: IWorkspaceDocumentRecord) {
        const normalizedRecord = createWorkspaceDocumentRecord(record);
        const hasIncomingDocument = normalizedRecord.documentIdentity !== null
            || normalizedRecord.tab.originalPath !== null
            || normalizedRecord.tab.fileName !== null
            || normalizedRecord.tab.isDjvu;
        const activeKind = snapshot.value.activeTransaction?.kind ?? null;
        if (
            closeRecordFenceActive
            && hasIncomingDocument
            && activeKind !== 'open'
            && activeKind !== 'restore'
            && activeKind !== 'reload'
        ) {
            return;
        }
        if (
            !snapshot.value.activeTransaction
            && areWorkspaceDocumentRecordsEqual(toDocumentRecord(), normalizedRecord)
        ) {
            return;
        }

        const nextIdentity = normalizeIdentityFromRecord(
            normalizedRecord,
            snapshot.value.identity,
            createDocumentSessionKey,
            createDocumentInstanceId,
            activeKind,
        );
        updateSnapshot((current) => {
            return {
                ...current,
                identity: nextIdentity,
                phase: resolvePhaseFromRecord(normalizedRecord, current.activeTransaction, current.phase),
                toolbarSnapshot: normalizedRecord.toolbarSnapshot,
                viewState: normalizedRecord.viewState,
                dirty: normalizedRecord.tab.isDirty,
                closeable: hasWorkspaceViewerDocumentCapabilities(normalizedRecord.toolbarSnapshot.viewerCapabilities),
                pendingDocumentPath: current.activeTransaction?.documentRef ?? null,
            };
        }, {incrementSessionRevision: !areIdentitiesEqual(
            snapshot.value.identity,
            nextIdentity,
        )});
    }

    function applyRevisionInfo(info: IDocumentRevisionInfo | null) {
        if (snapshot.value.identity.revisionInfo?.token === info?.token) {
            return;
        }

        updateSnapshot(current => ({
            ...current,
            identity: {
                ...current.identity,
                documentSessionKey: current.identity.documentSessionKey
                    ?? (info ? createDocumentSessionKey(info.documentRef) : null),
                documentInstanceId: current.identity.documentInstanceId
                    ?? (info ? createDocumentInstanceId() : null),
                documentRef: info?.documentRef ?? current.identity.originalPath,
                workingCopyPath: info?.documentRef ?? null,
                revisionInfo: info,
            },
        }), {incrementSessionRevision: true});
    }

    function applyViewState(state: ITabViewSessionState) {
        updateSnapshot(current => ({
            ...current,
            viewState: state,
        }));
    }

    function attachWorkspace(workspace: IWorkspaceExpose) {
        if (mountedWorkspace.value === workspace) {
            return;
        }

        mountedWorkspace.value = workspace;
        updateSnapshot(current => ({
            ...current,
            mounted: true,
        }));
        resolveAllWaiters(workspace);
    }

    function detachWorkspace(workspace?: IWorkspaceExpose) {
        if (workspace && mountedWorkspace.value !== workspace) {
            return;
        }
        if (!mountedWorkspace.value) {
            resolveAllWaiters(null);
            return;
        }

        mountedWorkspace.value = null;
        updateSnapshot(current => ({
            ...current,
            mounted: false,
        }));
        resolveAllWaiters(null);
    }

    async function waitForWorkspace(
        target: TWorkspaceCommandTarget,
        timeoutMs = workspaceWaitTimeoutMs,
    ) {
        if (!validateCommandTarget(target).ok) {
            return null;
        }

        if (mountedWorkspace.value) {
            return mountedWorkspace.value;
        }

        const workspace = await new Promise<IWorkspaceExpose | null>((resolve) => {
            const waiter: IWorkspaceWaiter = {
                target,
                resolve,
                timer: setTimeout(() => {
                    resolveWaiter(waiter, null);
                }, timeoutMs),
            };
            waiters.add(waiter);

            if (mountedWorkspace.value) {
                resolveWaiter(waiter, mountedWorkspace.value);
            }
        });

        return validateCommandTarget(target).ok ? workspace : null;
    }

    function createCommandTarget(mode: 'current' | 'active-transaction' = 'current'): TWorkspaceCommandTarget {
        const current = snapshot.value;
        if (mode === 'active-transaction' && current.activeTransaction) {
            return {
                kind: 'transaction',
                tabId: current.tabId,
                sessionId: current.sessionId,
                documentRef: current.activeTransaction.documentRef,
                ...getTargetDocumentBackend(current.activeTransaction.documentRef),
                ...getTargetDocumentInstanceId(current.identity),
                transactionId: current.activeTransaction.id,
                ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
            };
        }

        return {
            kind: 'revision',
            tabId: current.tabId,
            sessionId: current.sessionId,
            documentRef: current.identity.documentRef,
            ...getTargetDocumentBackend(current.identity.documentRef),
            ...getTargetDocumentInstanceId(current.identity),
            sessionRevision: current.sessionRevision,
            ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
        };
    }

    function validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    } {
        const current = snapshot.value;
        if (target.tabId !== current.tabId) {
            return {
                ok: false,
                reason: 'tab-id-mismatch',
            };
        }

        if (target.sessionId !== current.sessionId) {
            return {
                ok: false,
                reason: 'session-id-mismatch',
            };
        }

        if ((target.documentInstanceId ?? null) !== current.identity.documentInstanceId) {
            return {
                ok: false,
                reason: 'document-instance-id-mismatch',
            };
        }

        if (target.documentRef !== current.identity.documentRef) {
            return {
                ok: false,
                reason: 'document-ref-mismatch',
            };
        }

        const currentDocumentBackend = resolveDocumentRefBackend(current.identity.documentRef);
        if (target.documentBackend !== undefined && target.documentBackend !== currentDocumentBackend) {
            return {
                ok: false,
                reason: 'document-backend-mismatch',
            };
        }

        if (!isDocumentRevisionTokenEqual(target, current.identity.revisionInfo)) {
            return {
                ok: false,
                reason: 'document-revision-token-mismatch',
            };
        }

        if (target.kind === 'transaction') {
            if (current.activeTransaction?.id !== target.transactionId) {
                return {
                    ok: false,
                    reason: 'transaction-id-mismatch',
                };
            }
            return {ok: true};
        }

        if (target.sessionRevision !== current.sessionRevision) {
            return {
                ok: false,
                reason: 'session-revision-mismatch',
            };
        }

        return {ok: true};
    }

    function toDocumentRecord() {
        const current = snapshot.value;
        return createWorkspaceDocumentRecord({
            tab: {
                fileName: current.identity.fileName,
                originalPath: current.identity.originalPath,
                documentInstanceId: current.identity.documentInstanceId,
                isDirty: current.dirty,
                isDjvu: current.identity.isDjvu,
            },
            documentIdentity: current.identity.revisionInfo,
            toolbarSnapshot: current.toolbarSnapshot,
            viewState: current.viewState,
        });
    }

    return {
        tabId: options.tabId,
        snapshot,
        mountedWorkspace,
        beginTransaction,
        finishTransaction,
        applyWorkspaceRecord,
        applyRevisionInfo,
        applyViewState,
        attachWorkspace,
        detachWorkspace,
        waitForWorkspace,
        createCommandTarget,
        validateCommandTarget,
        toDocumentRecord,
    };
}
