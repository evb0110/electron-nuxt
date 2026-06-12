import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import type {
    IWorkspaceRestoreTrackerLike,
    IWorkspaceSplitCacheLike,
} from '@app/modules/workspace-shell/composables/workspaceSplitTypes';

interface IPageTransitionHistoryEntry {
    at: number;
    page: number;
}

interface IUseDocumentWorkspaceSplitRestoreOptions {
    tabId: string;
    pendingDocumentOpen: ComputedRef<boolean>;
    isTabTransitionBusy: ComputedRef<boolean>;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    hasPdf: Ref<boolean>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    isResizingSidebar: Ref<boolean>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<unknown>;
    zoom: Ref<number>;
    pdfViewerRef: Ref<{ getViewerContainer?: () => HTMLElement | null; } | null>;
    initFromStorage: () => void;
    cleanupSidebarResizeListeners: () => void;
    captureSplitPayload: () => Promise<TSplitPayload>;
    restoreSplitPayload: (payload: TSplitPayload) => Promise<void>;
    isRestoringSplitPayload: Ref<boolean>;
    currentPageTransitionHistory: Ref<IPageTransitionHistoryEntry[]>;
}

type TSplitRestoreSignalSnapshot = readonly [boolean, boolean, boolean, boolean, boolean];
type TWorkspaceViewControlSnapshot = readonly [unknown, unknown, boolean, number];

function shouldRestoreCachedSplitPayload(options: IUseDocumentWorkspaceSplitRestoreOptions) {
    return options.workspaceSplitCache.has(options.tabId)
        && !options.hasPdf.value
        && !options.pendingDocumentOpen.value;
}

function normalizeRestoredPage(page: number | undefined) {
    if (!page || !Number.isFinite(page)) {
        return null;
    }

    return Math.max(1, Math.floor(page));
}

function isCachedSplitEntryCurrent(
    cache: IWorkspaceSplitCacheLike,
    tabId: string,
    entryId: string,
) {
    return cache.peek(tabId)?.id === entryId;
}

export const useDocumentWorkspaceSplitRestore = (options: IUseDocumentWorkspaceSplitRestoreOptions) => {
    let splitPayloadCaptureGeneration = 0;
    let isWorkspaceMounted = true;
    const hasQueuedSplitRestore = computed(() => options.workspaceSplitCache.has(options.tabId));
    const isExternallyRestoring = computed(() => options.workspaceRestoreTracker.has(options.tabId));
    const suppressEmptyState = computed(() => (
        options.isRestoringSplitPayload.value
        || hasQueuedSplitRestore.value
        || isExternallyRestoring.value
    ));
    const canCacheSplitPayloadForRemount = computed(() => (
        options.isTabTransitionBusy.value
        && !options.isRestoringSplitPayload.value
        && !isExternallyRestoring.value
        && !options.pendingDocumentOpen.value
    ));

    function preseedPdfSnapshotPaging(payload: Extract<TSplitPayload, { kind: 'pdfSnapshot' }>) {
        const restoredPage = normalizeRestoredPage(payload.currentPage);
        if (restoredPage) {
            options.currentPage.value = restoredPage;
        }

        const restoredTotalPages = normalizeRestoredPage(payload.totalPages);
        if (!restoredTotalPages) {
            return;
        }

        const normalizedTotalPages = Math.max(options.currentPage.value, restoredTotalPages);
        options.totalPages.value = Math.max(options.totalPages.value, normalizedTotalPages);
    }

    function preseedCachedSplitPayload(payload: TSplitPayload) {
        if (payload.kind === 'pdfSnapshot') {
            preseedPdfSnapshotPaging(payload);
        }
    }

    async function restoreCachedSplitPayloadIfNeeded() {
        if (!shouldRestoreCachedSplitPayload(options)) {
            return;
        }

        const cached = options.workspaceSplitCache.peek(options.tabId);
        if (!cached) {
            return;
        }
        const { payload } = cached;

        options.isRestoringSplitPayload.value = true;
        try {
            preseedCachedSplitPayload(payload);
            BrowserLogger.diagnostic('toolbar-transition', 'Restoring cached split payload', {
                tabId: options.tabId,
                payloadKind: payload.kind,
                hadPdfBeforeRestore: options.hasPdf.value,
                payloadCurrentPage: payload.kind === 'pdfSnapshot' ? payload.currentPage : null,
                payloadTotalPages: payload.kind === 'pdfSnapshot' ? payload.totalPages : null,
                preseededCurrentPage: options.currentPage.value,
                preseededTotalPages: options.totalPages.value,
            });

            await options.restoreSplitPayload(payload);
            if (!isWorkspaceMounted || !isCachedSplitEntryCurrent(options.workspaceSplitCache, options.tabId, cached.id)) {
                return;
            }
            options.workspaceSplitCache.consume(options.tabId, cached.id);
        } catch (error) {
            if (!isWorkspaceMounted || !isCachedSplitEntryCurrent(options.workspaceSplitCache, options.tabId, cached.id)) {
                BrowserLogger.warn('workspace', 'Cached split payload restore finished after workspace became stale', {
                    tabId: options.tabId,
                    payloadKind: payload.kind,
                    error,
                });
                return;
            }
            const consumedPayload = options.workspaceSplitCache.consume(options.tabId, cached.id) ?? payload;
            BrowserLogger.warn('workspace', 'Failed to restore cached split payload', {
                tabId: options.tabId,
                payloadKind: payload.kind,
                error,
            });
            await cleanupSplitPayloadSnapshot(consumedPayload, {
                logSection: 'workspace',
                context: 'failed-cached-split-restore',
                metadata: {
                    tabId: options.tabId,
                    payloadKind: payload.kind,
                },
            });
        } finally {
            options.isRestoringSplitPayload.value = false;
        }
    }

    async function cacheSplitPayloadForRemount() {
        const captureGeneration = ++splitPayloadCaptureGeneration;
        if (!canCacheSplitPayloadForRemount.value) {
            BrowserLogger.debug('split-cache', 'Skipping split payload cache on unmount', {
                tabId: options.tabId,
                reason: 'guard-blocked',
                isTabTransitionBusy: options.isTabTransitionBusy.value,
                isRestoringSplitPayload: options.isRestoringSplitPayload.value,
                isExternallyRestoring: isExternallyRestoring.value,
                pendingDocumentOpen: options.pendingDocumentOpen.value,
            });
            return;
        }

        if (options.workspaceSplitCache.has(options.tabId)) {
            BrowserLogger.debug('split-cache', 'Skipping split payload cache on unmount', {
                tabId: options.tabId,
                reason: 'cache-already-populated',
            });
            return;
        }

        try {
            const payload = await options.captureSplitPayload();
            if (
                captureGeneration !== splitPayloadCaptureGeneration
                || !canCacheSplitPayloadForRemount.value
                || options.workspaceSplitCache.has(options.tabId)
            ) {
                BrowserLogger.debug('split-cache', 'Skipping split payload cache on unmount', {
                    tabId: options.tabId,
                    reason: 'post-capture-guard-blocked',
                    isTabTransitionBusy: options.isTabTransitionBusy.value,
                    isRestoringSplitPayload: options.isRestoringSplitPayload.value,
                    isExternallyRestoring: isExternallyRestoring.value,
                    pendingDocumentOpen: options.pendingDocumentOpen.value,
                });
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'split-cache',
                    context: 'post-capture-guard-blocked',
                    metadata: { tabId: options.tabId },
                });
                return;
            }
            if (payload.kind === 'empty') {
                BrowserLogger.debug('split-cache', 'Skipping split payload cache on unmount', {
                    tabId: options.tabId,
                    reason: 'captured-empty-payload',
                });
                return;
            }
            options.workspaceSplitCache.set(options.tabId, payload);
            BrowserLogger.debug('split-cache', 'Cached split payload on unmount', {
                tabId: options.tabId,
                payloadKind: payload.kind,
            });
        } catch (error) {
            BrowserLogger.warn('workspace', 'Failed to cache split payload on unmount', {
                tabId: options.tabId,
                error,
            });
        }
    }

    onMounted(() => {
        options.initFromStorage();
    });

    watch(
        [
            hasQueuedSplitRestore,
            options.hasPdf,
            options.isRestoringSplitPayload,
            isExternallyRestoring,
            options.pendingDocumentOpen,
        ],
        (snapshot: TSplitRestoreSignalSnapshot) => {
            const hasQueued = snapshot[0];
            const hasLoadedPdf = snapshot[1];
            const isRestoring = snapshot[2];
            const isExternalRestoreInProgress = snapshot[3];
            const pendingDocumentOpen = snapshot[4];

            if (!hasQueued || hasLoadedPdf || isRestoring || isExternalRestoreInProgress || pendingDocumentOpen) {
                return;
            }
            void restoreCachedSplitPayloadIfNeeded();
        },
        {immediate: true},
    );

    onBeforeUnmount(() => {
        isWorkspaceMounted = false;
        void cacheSplitPayloadForRemount();
    });

    watch(options.showSidebar, (next: boolean, previous: boolean) => {
        if (next === previous) {
            return;
        }
        const viewer = options.pdfViewerRef.value?.getViewerContainer?.() ?? null;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-sidebar] ${previous ? 'open' : 'closed'} -> ${next ? 'open' : 'closed'}`, {
            previous,
            next,
            currentPage: options.currentPage.value,
            sidebarTab: options.sidebarTab.value,
            isResizingSidebar: options.isResizingSidebar.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
        });
    });

    watch(options.currentPage, (next: number, previous: number) => {
        if (next === previous) {
            return;
        }
        const viewer = options.pdfViewerRef.value?.getViewerContainer?.() ?? null;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-page-ref] ${previous}->${next}`, {
            previous,
            next,
            sidebarOpen: options.showSidebar.value,
            sidebarTab: options.sidebarTab.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
            viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
        });

        const now = Date.now();
        options.currentPageTransitionHistory.value = [
            ...options.currentPageTransitionHistory.value,
            {
                page: next,
                at: now,
            },
        ].filter((entry) => now - entry.at <= 2000).slice(-8);

        const history: IPageTransitionHistoryEntry[] = options.currentPageTransitionHistory.value;
        if (history.length >= 3) {
            const last = history[history.length - 1]!;
            const mid = history[history.length - 2]!;
            const first = history[history.length - 3]!;
            const isBounce = first.page === last.page && first.page !== mid.page;
            if (isBounce) {
                BrowserLogger.diagnostic('pdf-nav', `[workspace-page-bounce] detected ${first.page}->${mid.page}->${last.page}`, {
                    history: history.map((entry) => ({
                        page: entry.page,
                        dtMs: now - entry.at,
                    })),
                    sidebarOpen: options.showSidebar.value,
                    sidebarTab: options.sidebarTab.value,
                    isResizingSidebar: options.isResizingSidebar.value,
                    fitMode: options.fitMode.value,
                    viewMode: options.viewMode.value,
                    continuousScroll: options.continuousScroll.value,
                    zoom: options.zoom.value,
                });
            }
        }
    });

    watch(
        () => [
            options.fitMode.value,
            options.viewMode.value,
            options.continuousScroll.value,
            options.zoom.value,
        ] as const,
        (nextSnapshot: TWorkspaceViewControlSnapshot, previousSnapshot: TWorkspaceViewControlSnapshot) => {
            const nextFit = nextSnapshot[0];
            const nextViewMode = nextSnapshot[1];
            const nextContinuous = nextSnapshot[2];
            const nextZoom = nextSnapshot[3];
            const prevFit = previousSnapshot[0];
            const prevViewMode = previousSnapshot[1];
            const prevContinuous = previousSnapshot[2];
            const prevZoom = previousSnapshot[3];

            if (
                nextFit === prevFit
                && nextViewMode === prevViewMode
                && nextContinuous === prevContinuous
                && nextZoom === prevZoom
            ) {
                return;
            }
            BrowserLogger.diagnostic('pdf-nav', 'DocumentWorkspace view controls changed', {
                fitMode: {
                    previous: prevFit,
                    next: nextFit,
                },
                viewMode: {
                    previous: prevViewMode,
                    next: nextViewMode,
                },
                continuousScroll: {
                    previous: prevContinuous,
                    next: nextContinuous,
                },
                zoom: {
                    previous: prevZoom,
                    next: nextZoom,
                },
                currentPage: options.currentPage.value,
                sidebarOpen: options.showSidebar.value,
            });
        },
    );

    onUnmounted(() => {
        options.cleanupSidebarResizeListeners();
    });

    return {
        canCacheSplitPayloadForRemount,
        hasQueuedSplitRestore,
        isExternallyRestoring,
        suppressEmptyState,
    };
};
