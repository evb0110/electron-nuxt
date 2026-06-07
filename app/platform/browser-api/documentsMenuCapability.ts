import type { IDocumentsMenuCapability } from '@contracts/electronApiDocuments';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

interface IOpenDocumentDirectBatchProgressPayload {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

const openDocumentDirectBatchProgressListeners =
    new Set<(progress: IOpenDocumentDirectBatchProgressPayload) => void>();

export function emitBrowserOpenDocumentDirectBatchProgress(
    progress: IOpenDocumentDirectBatchProgressPayload,
) {
    openDocumentDirectBatchProgressListeners.forEach((listener) => {
        listener(progress);
    });
}

export const browserDocumentsMenuCapability: IDocumentsMenuCapability = {
    setMenuDocumentState: async (_hasDocument) => {},
    setMenuTabCount: async (_tabCount) => {},
    onMenuOpenPdf: noopUnsubscribe,
    onMenuInsertImageFromFile: noopUnsubscribe,
    onMenuPasteImageFromClipboard: noopUnsubscribe,
    onMenuSave: noopUnsubscribe,
    onMenuRepairSave: noopUnsubscribe,
    onMenuSaveAs: noopUnsubscribe,
    onMenuPrint: noopUnsubscribe,
    onMenuPrintCurrentPage: noopUnsubscribe,
    onMenuExportDocx: noopUnsubscribe,
    onMenuExportImages: noopUnsubscribe,
    onMenuExportMultiPageTiff: noopUnsubscribe,
    onMenuZoomIn: noopUnsubscribe,
    onMenuZoomOut: noopUnsubscribe,
    onMenuActualSize: noopUnsubscribe,
    onMenuFitWidth: noopUnsubscribe,
    onMenuFitHeight: noopUnsubscribe,
    onMenuViewModeSingle: noopUnsubscribe,
    onMenuViewModeFacing: noopUnsubscribe,
    onMenuViewModeFacingFirstSingle: noopUnsubscribe,
    onMenuToggleAssistant: noopUnsubscribe,
    onMenuUndo: noopUnsubscribe,
    onMenuRedo: noopUnsubscribe,
    onMenuDeletePages: noopUnsubscribe,
    onMenuExtractPages: noopUnsubscribe,
    onMenuRotateCw: noopUnsubscribe,
    onMenuRotateCcw: noopUnsubscribe,
    onMenuInsertPages: noopUnsubscribe,
    onMenuOpenRecentFile: noopUnsubscribe,
    onMenuOpenExternalPaths: noopUnsubscribe,
    onMenuClearRecentFiles: noopUnsubscribe,
    onOpenDocumentDirectBatchProgress(callback) {
        openDocumentDirectBatchProgressListeners.add(callback);
        return () => {
            openDocumentDirectBatchProgressListeners.delete(callback);
        };
    },
    onOpenPdfDirectBatchProgress(callback) {
        return browserDocumentsMenuCapability.onOpenDocumentDirectBatchProgress(callback);
    },
};
