import type {
    IDocumentsMenuCapability,
    IOpenPdfDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

const openDocumentDirectBatchProgressListeners =
    new Set<(progress: IOpenPdfDirectBatchProgress) => void>();

export function emitBrowserOpenDocumentDirectBatchProgress(
    progress: IOpenPdfDirectBatchProgress,
) {
    openDocumentDirectBatchProgressListeners.forEach((listener) => {
        listener(progress);
    });
}

export const browserDocumentsMenuCapability: IDocumentsMenuCapability = {
    setMenuDocumentState: async (_hasDocument) => {},
    setMenuTabCount: async (_tabCount) => {},
    onPdfOptimizeProgress: noopUnsubscribe,
    onMenuOpenPdf: noopUnsubscribe,
    onMenuInsertImageFromFile: noopUnsubscribe,
    onMenuPasteImageFromClipboard: noopUnsubscribe,
    onMenuSave: noopUnsubscribe,
    onMenuRepairSave: noopUnsubscribe,
    onMenuOptimizePdfForInteraction: noopUnsubscribe,
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
    onMenuToggleContinuousScroll: noopUnsubscribe,
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
