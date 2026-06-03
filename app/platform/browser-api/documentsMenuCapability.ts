import type { IDocumentsMenuCapability } from '@contracts/platformApi';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

interface IOpenPdfDirectBatchProgressPayload {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

const openPdfDirectBatchProgressListeners =
    new Set<(progress: IOpenPdfDirectBatchProgressPayload) => void>();

export function emitBrowserOpenPdfDirectBatchProgress(
    progress: IOpenPdfDirectBatchProgressPayload,
) {
    openPdfDirectBatchProgressListeners.forEach((listener) => {
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
    onOpenPdfDirectBatchProgress(callback) {
        openPdfDirectBatchProgressListeners.add(callback);
        return () => {
            openPdfDirectBatchProgressListeners.delete(callback);
        };
    },
};
