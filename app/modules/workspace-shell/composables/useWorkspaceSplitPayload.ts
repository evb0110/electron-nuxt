import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TSplitPayload } from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';
import { readDocumentBytes } from '@app/utils/documentBytes';
import type {
    IWorkspaceDocumentViewerSplitPort,
    IWorkspacePdfViewerSplitPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TPdfSource } from '@app/types/pdfUi';
import { getDocumentWorkingCopyCapability } from '@app/utils/platformDocuments';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';

interface IUseWorkspaceSplitPayloadOptions {
    pdfSrc: Ref<TPdfSource | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    hasPendingTabChanges: Ref<boolean>;
    pdfViewerRef: Ref<IWorkspacePdfViewerSplitPort | null>;
    documentViewerRef: Ref<IWorkspaceDocumentViewerSplitPort | null>;
    pdfData: Ref<Uint8Array | null>;
    serializePdfForSave?: (
        data: Uint8Array,
        options?: {
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
        },
    ) => Promise<Uint8Array>;
    openFileWithViewerLifecycle: (result: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

type TPdfSnapshotSplitPayload = Extract<TSplitPayload, { kind: 'pdfSnapshot' }>;

function normalizeSplitPayloadPage(page: number | undefined) {
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        return null;
    }

    return Math.max(1, Math.floor(page));
}

function normalizeSplitPayloadTotalPages(total: number | undefined, fallbackPage: number) {
    if (typeof total !== 'number' || !Number.isFinite(total)) {
        return fallbackPage;
    }

    return Math.max(fallbackPage, Math.floor(total));
}

export const useWorkspaceSplitPayload = (options: IUseWorkspaceSplitPayloadOptions) => {
    const runWithDocumentOperationLease = options.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;

    function createPdfSnapshotPayload(snapshotPath: TDocumentRef, isDirty: boolean): TPdfSnapshotSplitPayload {
        const normalizedCurrentPage = normalizeSplitPayloadPage(options.currentPage.value) ?? 1;
        const originalBackend = resolveDocumentRefBackend(options.originalPath.value);
        const snapshotBackend = resolveDocumentRefBackend(snapshotPath);
        return {
            kind: 'pdfSnapshot',
            fileName: options.fileName.value ?? 'document.pdf',
            originalPath: options.originalPath.value,
            ...(originalBackend === undefined ? {} : {originalBackend}),
            snapshotPath,
            ...(snapshotBackend === undefined ? {} : {snapshotBackend}),
            isDirty,
            currentPage: normalizedCurrentPage,
            totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
        };
    }

    async function captureCleanWorkingCopySnapshot(): Promise<TPdfSnapshotSplitPayload | null> {
        if (!options.workingCopyPath.value || options.hasPendingTabChanges.value) {
            return null;
        }

        try {
            const snapshotPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(
                options.workingCopyPath.value,
                options.originalPath.value ?? undefined,
            );
            return createPdfSnapshotPayload(snapshotPath, false);
        } catch (error) {
            BrowserLogger.warn('workspace', 'Failed to create split payload from working copy path', {
                path: options.workingCopyPath.value,
                error,
            });
            return null;
        }
    }

    async function resolvePdfSnapshotData() {
        return runWithDocumentOperationLease('split-capture', async () => {
            const viewerTransaction = await options.pdfViewerRef.value?.runSaveTransaction({
                mode: 'snapshot',
                forcePdfjsMaterialize: true,
                ...(options.serializePdfForSave ? {
                    serializeResult: true,
                    includeManagedShapes: true,
                    rewriteShapeState: true,
                    source: {
                        getSourcePdfData: async () => {
                            if (options.pdfData.value) {
                                return options.pdfData.value;
                            }
                            return options.workingCopyPath.value
                                ? readDocumentBytes(options.workingCopyPath.value)
                                : null;
                        },
                        serializePdfForSave: options.serializePdfForSave,
                    },
                } : {}),
            });
            const viewerSnapshot = viewerTransaction?.serializedBytes ?? viewerTransaction?.baseBytes ?? null;
            if (viewerSnapshot) {
                return viewerSnapshot;
            }

            if (options.pdfData.value) {
                return options.pdfData.value;
            }

            if (!options.workingCopyPath.value) {
                return null;
            }

            try {
                return await readDocumentBytes(options.workingCopyPath.value);
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to read working copy for split payload', {
                    path: options.workingCopyPath.value,
                    error,
                });
                return null;
            }
        });
    }

    async function capturePdfSnapshotPayload(): Promise<TSplitPayload> {
        const cleanWorkingCopySnapshot = await captureCleanWorkingCopySnapshot();
        if (cleanWorkingCopySnapshot) {
            return cleanWorkingCopySnapshot;
        }

        const snapshot = await resolvePdfSnapshotData();
        if (!snapshot) {
            return { kind: 'empty' };
        }

        const snapshotPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromData(
            options.fileName.value ?? 'document.pdf',
            snapshot,
            options.originalPath.value ?? undefined,
        );
        return createPdfSnapshotPayload(snapshotPath, options.hasPendingTabChanges.value);
    }

    async function captureSplitPayload(): Promise<TSplitPayload> {
        // DjVu check must precede pdfSrc guard: DjVu mode has pdfSrc=null.
        if (options.isDjvuMode.value && options.djvuSourcePath.value) {
            const normalizedCurrentPage = normalizeSplitPayloadPage(
                options.documentViewerRef.value?.getCurrentPage?.() ?? options.currentPage.value,
            ) ?? 1;
            const sourceBackend = resolveDocumentRefBackend(options.djvuSourcePath.value);
            return {
                kind: 'djvu',
                sourcePath: options.djvuSourcePath.value,
                ...(sourceBackend === undefined ? {} : {sourceBackend}),
                currentPage: normalizedCurrentPage,
                totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
            };
        }

        if (!options.pdfSrc.value) {
            return { kind: 'empty' };
        }

        return capturePdfSnapshotPayload();
    }

    async function restoreSplitPayload(payload: TSplitPayload) {
        if (payload.kind === 'empty') {
            return;
        }

        if (payload.kind === 'djvu') {
            const pageToRestore = normalizeSplitPayloadPage(payload.currentPage);
            if (pageToRestore) {
                options.currentPage.value = pageToRestore;
            }
            if (payload.totalPages && Number.isFinite(payload.totalPages)) {
                options.totalPages.value = Math.max(
                    options.totalPages.value,
                    Math.floor(payload.totalPages),
                    pageToRestore ?? 1,
                );
            }
            await options.openFileWithViewerLifecycle({
                kind: 'djvu',
                workingPath: '',
                originalPath: payload.sourcePath,
            });
            if (pageToRestore) {
                await nextTick();
                options.documentViewerRef.value?.scrollToPage(pageToRestore);
            }
            return;
        }

        const pageToRestore = normalizeSplitPayloadPage(payload.currentPage);
        if (payload.totalPages && Number.isFinite(payload.totalPages)) {
            options.totalPages.value = Math.max(options.totalPages.value, Math.floor(payload.totalPages));
        }
        const restorePagePromise = pageToRestore && pageToRestore > 1
            ? options.waitForPdfReload(pageToRestore).catch((error) => {
                const restorePageError: unknown = error;
                BrowserLogger.debug('workspace', 'Split payload page restore wait failed', {
                    pageToRestore,
                    error: restorePageError,
                });
            })
            : null;

        await options.loadPdfFromPath(payload.snapshotPath, { markDirty: payload.isDirty });
        options.originalPath.value = payload.originalPath;

        if (restorePagePromise) {
            await restorePagePromise;
        }
    }

    return {
        captureSplitPayload,
        restoreSplitPayload,
    };
};
