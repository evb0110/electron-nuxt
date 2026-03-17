import type { Ref } from 'vue';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { TSplitPayload } from '@contracts/window-tabs';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';
import type { TPdfSource } from '@app/types/pdf';

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

export function useWorkspaceSplitPayload(options: IUseWorkspaceSplitPayloadOptions) {
    async function captureSplitPayload(): Promise<TSplitPayload> {
        if (!options.pdfSrc.value) {
            return { kind: 'empty' };
        }

        if (options.isDjvuMode.value && options.djvuSourcePath.value) {
            return {
                kind: 'djvu',
                sourcePath: options.djvuSourcePath.value,
            };
        }

        const normalizedCurrentPage = normalizeSplitPayloadPage(options.currentPage.value) ?? 1;
        const api = getElectronAPI();
        const normalizedFileName = options.fileName.value ?? 'document.pdf';

        if (options.workingCopyPath.value && !options.hasPendingTabChanges.value) {
            try {
                const snapshotPath = await api.documents.createWorkingCopyFromPath(
                    options.workingCopyPath.value,
                    options.originalPath.value ?? undefined,
                );
                return {
                    kind: 'pdfSnapshot',
                    fileName: normalizedFileName,
                    originalPath: options.originalPath.value,
                    snapshotPath,
                    isDirty: false,
                    currentPage: normalizedCurrentPage,
                    totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
                };
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to create split payload from working copy path', {
                    path: options.workingCopyPath.value,
                    error,
                });
            }
        }

        let snapshot = await options.pdfViewerRef.value?.saveDocument?.() ?? null;
        if (!snapshot && options.pdfData.value) {
            snapshot = options.pdfData.value.slice();
        }

        if (!snapshot && options.workingCopyPath.value) {
            try {
                snapshot = await api.documents.readFile(options.workingCopyPath.value);
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to read working copy for split payload', {
                    path: options.workingCopyPath.value,
                    error,
                });
            }
        }

        if (!snapshot) {
            return { kind: 'empty' };
        }

        const snapshotPath = await api.documents.createWorkingCopyFromData(
            normalizedFileName,
            snapshot,
            options.originalPath.value ?? undefined,
        );
        return {
            kind: 'pdfSnapshot',
            fileName: normalizedFileName,
            originalPath: options.originalPath.value,
            snapshotPath,
            isDirty: options.hasPendingTabChanges.value,
            currentPage: normalizedCurrentPage,
            totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
        };
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
}
