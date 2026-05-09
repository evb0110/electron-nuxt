import type { IpcRenderer } from 'electron';
import type { IDocumentsMenuCapability } from '@contracts/platform-api';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
} from '@electron/features/documents/contract';
import {
    createIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipc-client';
import type {
    IDocumentsEventMap,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@electron/features/documents/preload-shared';

export function createDocumentsPreloadMenuClient(
    ipcRenderer: IpcRenderer,
): IDocumentsMenuCapability {
    const eventSubscriber = createTypedIpcEventSubscriber<IDocumentsEventMap>(ipcRenderer);
    const invoke = createIpcInvoker(ipcRenderer);

    return {
        setMenuDocumentState: (hasDocument: boolean) =>
            invoke(DOCUMENTS_CHANNELS.menuSetDocumentState, hasDocument),
        setMenuTabCount: (tabCount: number) =>
            invoke(DOCUMENTS_CHANNELS.menuSetTabCount, tabCount),
        onMenuOpenPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuOpenPdf, callback),
        onMenuInsertImageFromFile: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuInsertImageFromFile, callback),
        onMenuPasteImageFromClipboard: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPasteImageFromClipboard, callback),
        onMenuSave: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuSave, callback),
        onMenuSaveAs: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuSaveAs, callback),
        onMenuPrint: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPrint, callback),
        onMenuPrintCurrentPage: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPrintCurrentPage, callback),
        onMenuExportDocx: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportDocx, callback),
        onMenuExportImages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportImages, callback),
        onMenuExportMultiPageTiff: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportMultiPageTiff, callback),
        onMenuZoomIn: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuZoomIn, callback),
        onMenuZoomOut: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuZoomOut, callback),
        onMenuActualSize: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuActualSize, callback),
        onMenuFitWidth: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuFitWidth, callback),
        onMenuFitHeight: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuFitHeight, callback),
        onMenuViewModeSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeSingle, callback),
        onMenuViewModeFacing: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeFacing, callback),
        onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeFacingFirstSingle, callback),
        onMenuUndo: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuUndo, callback),
        onMenuRedo: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRedo, callback),
        onMenuDeletePages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuDeletePages, callback),
        onMenuExtractPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExtractPages, callback),
        onMenuRotateCw: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRotateCw, callback),
        onMenuRotateCcw: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRotateCcw, callback),
        onMenuInsertPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuInsertPages, callback),
        onMenuOpenRecentFile: (callback: (filePath: string) => void): IMenuEventUnsubscribe =>
            eventSubscriber.onPayload(DOCUMENTS_EVENT_CHANNELS.menuOpenRecentFile, callback),
        onMenuOpenExternalPaths: (callback: (paths: string[]) => void): IMenuEventUnsubscribe =>
            eventSubscriber.onPayload(DOCUMENTS_EVENT_CHANNELS.menuOpenExternalPaths, callback),
        onMenuClearRecentFiles: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            eventSubscriber.onNoArg(DOCUMENTS_EVENT_CHANNELS.menuClearRecentFiles, callback),
        onOpenPdfDirectBatchProgress: (callback: (progress: {
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }) => void): IMenuEventUnsubscribe => eventSubscriber.onPayload(
            DOCUMENTS_EVENT_CHANNELS.openPdfDirectBatchProgress,
            callback,
        ),
    };
}
