import { delay } from 'es-toolkit/promise';
import type { ShallowRef } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TTabUpdate } from '@app/types/tabs';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { readRecentOpenExactGeometry } from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentOpeningPageFrameAuthority } from '@app/utils/document-viewer/chassis/documentOpeningPageFrameAuthority';

export interface IWorkspaceDocumentOpenHost {
    documentOpenSurface: IDocumentOpenSurfaceSession;
    openingPageFrameAuthority: ShallowRef<IDocumentOpeningPageFrameAuthority | null>;
    ensureWorkspaceLoaded: (reason: string) => Promise<IWorkspaceExpose | null>;
    getActiveTransactionId: () => string | null;
    getInitialViewState: () => {currentPage?: number | undefined} | null | undefined;
    getSeedToolbarSnapshot: () => IWorkspaceToolbarSnapshot;
    hasDocumentOrOpenError: () => boolean;
    hasOpenedDocument: () => boolean;
    hasSessionOpenedDocument: () => boolean;
    isHostUnmounted: () => boolean;
    isViewerOwnerMounted: () => boolean;
    publishDocumentRecord: (record: IWorkspaceDocumentRecord) => void;
    requestWorkspaceMount: (reason: string) => void;
}

interface IDocumentOpenTransactionRun {
    transactionId: string;
    action: string;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

function shouldSeedPendingTabHint(target: TTabUpdate | null | undefined, hasWorkspaceOpenedDocument: boolean,
    hasWorkspaceSessionOpenedDocument: boolean) {
    return Boolean(target && !hasWorkspaceOpenedDocument && !hasWorkspaceSessionOpenedDocument);
}

export function resolveOpenSurfaceDocumentId(target: TTabUpdate | null, transactionDocumentRef: TDocumentRef | null, fallbackId: string) {
    return String(target?.originalPath ?? transactionDocumentRef ?? fallbackId);
}

export function resolvePreparedPdfOpeningGeometry(documentId: string, geometry: IPdfOpeningGeometry | null | undefined) {
    return !geometry || documentId.length === 0
        ? null
        : Object.freeze({
            documentId,
            ...geometry,
        });
}

export function shouldWaitForPreparedOpeningOwner(hasPreparedOpeningGeometry: boolean, ownerMounted: boolean) {
    return hasPreparedOpeningGeometry && !ownerMounted;
}

export function canBeginDocumentOpenSynchronously(action: string, hasPreparedOpeningGeometry: boolean, ownerMounted: boolean) {
    return action === 'openRecentFromPlaceholder'
        && hasPreparedOpeningGeometry
        && ownerMounted;
}

export function resolveDocumentOpenRunResult<T>(result: T | false, reachedTerminalState: boolean) {
    return result !== false && reachedTerminalState
        ? result
        : false;
}

export function createWorkspaceDocumentOpenTransactions(options: {
    tabId: string;
    mountedWorkspace: ShallowRef<IWorkspaceExpose | null>;
}) {
    let host: IWorkspaceDocumentOpenHost | null = null;
    let hostEverAttached = false;
    let pendingPreOwnerGoToPage: readonly [page: number, attempt: number] | null = null;
    let documentOpenAttemptCounter = 0;

    function attachHost(nextHost: IWorkspaceDocumentOpenHost) {
        host = nextHost;
        hostEverAttached = true;
        pendingPreOwnerGoToPage = null;
        documentOpenAttemptCounter = 0;
        return () => {
            if (host === nextHost) {
                host = null;
                pendingPreOwnerGoToPage = null;
                documentOpenAttemptCounter = 0;
            }
        };
    }

    function workspaceHasSuccessfulInitialVisual() {
        const toolbarSnapshot = options.mountedWorkspace.value?.getToolbarSnapshot();
        return Boolean(toolbarSnapshot?.initialVisualReady
            && !toolbarSnapshot.hasOpenError
            && hasWorkspaceViewerDocumentCapabilities(toolbarSnapshot.viewerCapabilities));
    }

    function beginDocumentOpenTransaction(openHost: IWorkspaceDocumentOpenHost, intent: IDocumentOpenIntent,
        transactionId: string, transactionDocumentRef: TDocumentRef | null) {
        const target = intent.target ?? null;
        const currentSurface = openHost.documentOpenSurface.snapshot.value;
        const canUsePreparedRecentFrame = intent.action === 'openRecentFromPlaceholder'
            && (
                currentSurface.phase === 'idle'
                || currentSurface.phase === 'ready'
                || currentSurface.phase === 'failed'
            );
        const cachedRecentGeometry = canUsePreparedRecentFrame && target?.originalPath
            ? readRecentOpenExactGeometry(target.originalPath, {
                modifiedAt: intent.preparedSourceModifiedAt,
                size: intent.preparedSourceSize,
            })
            : null;
        const transaction: IDocumentOpenTransactionRun = {
            transactionId,
            action: intent.action,
            target,
            seededTabHint: shouldSeedPendingTabHint(
                target,
                openHost.hasOpenedDocument(),
                openHost.hasSessionOpenedDocument(),
            ),
        };

        if (
            currentSurface.phase === 'idle'
            || currentSurface.phase === 'ready'
            || currentSurface.phase === 'failed'
        ) {
            const documentId = resolveOpenSurfaceDocumentId(
                target,
                transactionDocumentRef,
                options.tabId,
            );
            const identity = {
                documentId,
                documentRevision: `open-intent:${transactionId}`,
            };
            const preparedOpeningGeometry = resolvePreparedPdfOpeningGeometry(
                documentId,
                intent.preparedOpeningGeometry,
            ) ?? cachedRecentGeometry;
            const initialViewState = openHost.getInitialViewState();
            const restoredInitialPage = intent.action.toLowerCase().includes('restore')
                ? Math.max(1, Math.trunc(initialViewState?.currentPage ?? 1))
                : null;
            const exactOpeningGeometry = preparedOpeningGeometry ?? readRecentOpenExactGeometry(documentId);
            const ownedOpeningGeometry = restoredInitialPage === null
                || exactOpeningGeometry?.pageNumber === restoredInitialPage
                ? exactOpeningGeometry
                : null;
            const preparedOpeningFrame = ownedOpeningGeometry
                ? openHost.openingPageFrameAuthority.value?.draftOpeningPageFrame(ownedOpeningGeometry) ?? null
                : null;
            const generation = preparedOpeningFrame
                ? openHost.documentOpenSurface.beginPrepared(identity, preparedOpeningFrame)
                : openHost.documentOpenSurface.begin(
                    identity,
                    ownedOpeningGeometry,
                    restoredInitialPage ?? ownedOpeningGeometry?.pageNumber ?? 1,
                );
            if (generation === null) {
                BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction rejected because the prepared page frame could not be committed atomically', {
                    tabId: options.tabId,
                    action: intent.action,
                    target,
                });
                return null;
            }
            if (!preparedOpeningFrame) {
                openHost.openingPageFrameAuthority.value?.prepareOpeningPageFrame(generation);
            }
            if (pendingPreOwnerGoToPage !== null) {
                if (pendingPreOwnerGoToPage[1] === documentOpenAttemptCounter) {
                    openHost.documentOpenSurface.requestNavigation(pendingPreOwnerGoToPage[0]);
                }
                pendingPreOwnerGoToPage = null;
            }
        }

        if (transaction.seededTabHint && target) {
            openHost.publishDocumentRecord(createPendingWorkspaceDocumentRecord(
                target,
                openHost.getSeedToolbarSnapshot(),
            ));
        }

        openHost.requestWorkspaceMount(`document-open:${intent.action}`);

        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction started', {
            tabId: options.tabId,
            transactionId,
            action: transaction.action,
            seededTabHint: transaction.seededTabHint,
            target: transaction.target,
        });

        return transaction;
    }

    async function waitForDocumentOpenTerminalState(openHost: IWorkspaceDocumentOpenHost,
        transaction: IDocumentOpenTransactionRun, opened: boolean) {
        await nextTick();
        if (!opened) {
            return false;
        }
        const deadline = Date.now() + DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS;
        while (
            !openHost.isHostUnmounted()
            && openHost.getActiveTransactionId() === transaction.transactionId
            && Date.now() < deadline
        ) {
            const workspace = options.mountedWorkspace.value;
            if (workspace) {
                const remainingMs = Math.max(0, deadline - Date.now());
                if (remainingMs > 0) {
                    try {
                        await Promise.race([
                            workspace.waitForDocumentOpenSettled(),
                            delay(remainingMs).then(() => {
                                throw new Error('Document open settle timed out');
                            }),
                        ]);
                    } catch (error) {
                        BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open settle wait failed', {
                            tabId: options.tabId,
                            transactionId: transaction.transactionId,
                            action: transaction.action,
                            target: transaction.target,
                            error,
                        });
                        return false;
                    }
                }
                if (workspace.getToolbarSnapshot().hasOpenError) {
                    return false;
                }
                if (workspaceHasSuccessfulInitialVisual()) {
                    return true;
                }
            } else {
                await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
            }
        }
        if (!workspaceHasSuccessfulInitialVisual()) {
            BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
                tabId: options.tabId,
                transactionId: transaction.transactionId,
                action: transaction.action,
                target: transaction.target,
                timeoutMs: DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
                hasMountedWorkspace: options.mountedWorkspace.value !== null,
            });
        }
        return workspaceHasSuccessfulInitialVisual();
    }

    function finishDocumentOpenPresentation(openHost: IWorkspaceDocumentOpenHost,
        transaction: IDocumentOpenTransactionRun, opened: boolean) {
        pendingPreOwnerGoToPage = null;
        if (
            !opened
            && transaction.seededTabHint
            && !openHost.hasDocumentOrOpenError()
        ) {
            openHost.publishDocumentRecord(createWorkspaceDocumentRecord());
        }
        if (
            !opened
            && openHost.documentOpenSurface.snapshot.value.identity?.documentRevision.startsWith('open-intent:')
        ) {
            openHost.documentOpenSurface.reset();
        }
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
            tabId: options.tabId,
            transactionId: transaction.transactionId,
            action: transaction.action,
            opened,
            hasTerminalDocumentState: openHost.hasDocumentOrOpenError(),
        });
    }

    function hasPreparedOpeningGeometry(intent: IDocumentOpenIntent) {
        return intent.preparedOpeningGeometry !== undefined
            || Boolean(intent.target?.originalPath && readRecentOpenExactGeometry(intent.target.originalPath));
    }

    async function ensurePreparedOpeningOwnerReady(openHost: IWorkspaceDocumentOpenHost, intent: IDocumentOpenIntent,
        preparedOpeningGeometryAvailable: boolean) {
        if (!shouldWaitForPreparedOpeningOwner(
            preparedOpeningGeometryAvailable,
            openHost.isViewerOwnerMounted(),
        )) {
            return true;
        }
        openHost.requestWorkspaceMount(`prepared-opening-owner:${intent.action}`);
        const workspace = await openHost.ensureWorkspaceLoaded(`prepared-opening-owner:${intent.action}`);
        if (!workspace) {
            return false;
        }
        const deadline = Date.now() + DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_TIMEOUT_MS;
        while (!openHost.isHostUnmounted() && Date.now() < deadline) {
            if (openHost.isViewerOwnerMounted()) {
                return true;
            }
            await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
        }
        BrowserLogger.error(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Prepared document open timed out before the canonical viewer owner mounted', {
            tabId: options.tabId,
            action: intent.action,
        });
        return false;
    }

    async function run<T>(intent: IDocumentOpenIntent, transactionId: string,
        transactionDocumentRef: TDocumentRef | null, sourceOpen: () => Promise<T>): Promise<T | false> {
        const openHost = host;
        if (!openHost) {
            // A detached presentation host refuses opens, preserving the
            // pre-consolidation unmounted-host contract for stale expose
            // proxies and transactions queued behind an unmount. Only a
            // controller that never had a host runs source opens bare.
            return hostEverAttached ? false : sourceOpen();
        }
        if (openHost.isHostUnmounted()) {
            return false;
        }
        // Keep the mounted path in the click call stack so rapid page commands cannot overtake the open transaction.
        const preparedOpeningGeometryAvailable = hasPreparedOpeningGeometry(intent);
        documentOpenAttemptCounter += 1;
        const transaction = beginDocumentOpenTransaction(openHost, intent, transactionId, transactionDocumentRef);
        if (!transaction) {
            pendingPreOwnerGoToPage = null;
            return false;
        }
        let opened = false;
        try {
            // Claim the session and opening surface before waiting for the async workspace owner.
            if (
                !canBeginDocumentOpenSynchronously(
                    intent.action,
                    preparedOpeningGeometryAvailable,
                    openHost.isViewerOwnerMounted(),
                )
                && !await ensurePreparedOpeningOwnerReady(
                    openHost,
                    intent,
                    preparedOpeningGeometryAvailable,
                )
            ) {
                pendingPreOwnerGoToPage = null;
                return false;
            }
            // Flush synchronous `beginPrepared()` ownership before source loading.
            if (openHost.documentOpenSurface.snapshot.value.presentation === 'page-shell') {
                await nextTick();
                if (openHost.getActiveTransactionId() !== transaction.transactionId) {
                    return false;
                }
            }
            const result = await sourceOpen();
            const settledResult = resolveDocumentOpenRunResult(
                result,
                await waitForDocumentOpenTerminalState(openHost, transaction, result !== false),
            );
            if (settledResult === false) {
                return false;
            }
            opened = true;
            return settledResult;
        } finally {
            finishDocumentOpenPresentation(openHost, transaction, opened);
        }
    }

    function requestPage(page: number) {
        const openHost = host;
        if (!openHost) {
            return;
        }
        if (openHost.documentOpenSurface.viewportSession.value.identity === null) {
            pendingPreOwnerGoToPage = [
                page,
                documentOpenAttemptCounter,
            ];
            return;
        }
        openHost.documentOpenSurface.requestNavigation(page);
    }

    return {
        attachHost,
        requestPage,
        run,
    };
}
