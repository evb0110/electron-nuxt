import type { Ref } from 'vue';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { TSplitPayload } from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';
import { readDocumentBytes } from '@app/utils/documentBytes';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import type { TPdfSource } from '@app/types/pdf';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

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
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    pdfData: Ref<Uint8Array | null>;
    openFileWithDjvuCleanup: (result: TOpenFileResult) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
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
    function createPdfSnapshotPayload(snapshotPath: TDocumentRef, isDirty: boolean): TPdfSnapshotSplitPayload {
        const normalizedCurrentPage = normalizeSplitPayloadPage(options.currentPage.value) ?? 1;
        return {
            kind: 'pdfSnapshot',
            fileName: options.fileName.value ?? 'document.pdf',
            originalPath: options.originalPath.value,
            snapshotPath,
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
            const snapshotPath = await getDocumentsCapability().createWorkingCopyFromPath(
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
        const viewerSnapshot = await options.pdfViewerRef.value?.saveDocument?.() ?? null;
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

        const snapshotPath = await getDocumentsCapability().createWorkingCopyFromData(
            options.fileName.value ?? 'document.pdf',
            snapshot,
            options.originalPath.value ?? undefined,
        );
        return createPdfSnapshotPayload(snapshotPath, options.hasPendingTabChanges.value);
    }

    async function captureSplitPayload(): Promise<TSplitPayload> {
        // DjVu check must precede pdfSrc guard: DjVu mode has pdfSrc=null.
        if (options.isDjvuMode.value && options.djvuSourcePath.value) {
            return {
                kind: 'djvu',
                sourcePath: options.djvuSourcePath.value,
            };
        }

        if (!options.pdfSrc.value) {
            return { kind: 'empty' };
        }

        return capturePdfSnapshotPayload();
    }

    async function restoreSplitPayload(payload: TSplitPayload): Promise<void> {
        if (payload.kind === 'empty') {
            return;
        }

        if (payload.kind === 'djvu') {
            await options.openFileWithDjvuCleanup({
                kind: 'djvu',
                workingPath: '',
                originalPath: payload.sourcePath,
            });
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
