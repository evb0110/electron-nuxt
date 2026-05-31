import type { IpcRenderer } from 'electron';
import type { IDocumentsMenuCapability } from '@contracts/platformApi';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
    type IDocumentsEventMap,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@electron/features/documents/preloadShared';

type TNoArgDocumentMenuSubscriptions = Pick<
    IDocumentsMenuCapability,
    | 'onMenuOpenPdf'
    | 'onMenuInsertImageFromFile'
    | 'onMenuPasteImageFromClipboard'
    | 'onMenuSave'
    | 'onMenuSaveAs'
    | 'onMenuPrint'
    | 'onMenuPrintCurrentPage'
    | 'onMenuExportDocx'
    | 'onMenuExportImages'
    | 'onMenuExportMultiPageTiff'
    | 'onMenuZoomIn'
    | 'onMenuZoomOut'
    | 'onMenuActualSize'
    | 'onMenuFitWidth'
    | 'onMenuFitHeight'
    | 'onMenuViewModeSingle'
    | 'onMenuViewModeFacing'
    | 'onMenuViewModeFacingFirstSingle'
    | 'onMenuUndo'
    | 'onMenuRedo'
    | 'onMenuDeletePages'
    | 'onMenuExtractPages'
    | 'onMenuRotateCw'
    | 'onMenuRotateCcw'
    | 'onMenuInsertPages'
    | 'onMenuClearRecentFiles'
>;

type TNoArgDocumentMenuChannel = Extract<{
    [TChannel in keyof IDocumentsEventMap]: IDocumentsEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof IDocumentsEventMap], string>;

export function createDocumentsPreloadMenuClient(
    ipcRenderer: IpcRenderer,
): IDocumentsMenuCapability {
    const eventSubscriber = createTypedIpcEventSubscriber<IDocumentsEventMap>(ipcRenderer);
    const invoke = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer);
    const onNoArg = (channel: TNoArgDocumentMenuChannel) =>
        (callback: IMenuEventCallback): IMenuEventUnsubscribe => eventSubscriber.onNoArg(channel, callback);
    const noArgMenuSubscriptions = {
        onMenuOpenPdf: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuOpenPdf),
        onMenuInsertImageFromFile: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuInsertImageFromFile),
        onMenuPasteImageFromClipboard: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPasteImageFromClipboard),
        onMenuSave: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuSave),
        onMenuSaveAs: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuSaveAs),
        onMenuPrint: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPrint),
        onMenuPrintCurrentPage: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuPrintCurrentPage),
        onMenuExportDocx: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportDocx),
        onMenuExportImages: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportImages),
        onMenuExportMultiPageTiff: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExportMultiPageTiff),
        onMenuZoomIn: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuZoomIn),
        onMenuZoomOut: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuZoomOut),
        onMenuActualSize: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuActualSize),
        onMenuFitWidth: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuFitWidth),
        onMenuFitHeight: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuFitHeight),
        onMenuViewModeSingle: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeSingle),
        onMenuViewModeFacing: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeFacing),
        onMenuViewModeFacingFirstSingle: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuViewModeFacingFirstSingle),
        onMenuUndo: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuUndo),
        onMenuRedo: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRedo),
        onMenuDeletePages: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuDeletePages),
        onMenuExtractPages: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuExtractPages),
        onMenuRotateCw: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRotateCw),
        onMenuRotateCcw: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuRotateCcw),
        onMenuInsertPages: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuInsertPages),
        onMenuClearRecentFiles: onNoArg(DOCUMENTS_EVENT_CHANNELS.menuClearRecentFiles),
    } satisfies TNoArgDocumentMenuSubscriptions;

    return {
        setMenuDocumentState: (state: boolean | {
            hasDocument: boolean;
            canSave: boolean 
        }) =>
            invoke(DOCUMENTS_CHANNELS.menuSetDocumentState, state),
        setMenuTabCount: (tabCount: number) =>
            invoke(DOCUMENTS_CHANNELS.menuSetTabCount, tabCount),
        ...noArgMenuSubscriptions,
        onMenuOpenRecentFile: (callback: (filePath: string) => void): IMenuEventUnsubscribe =>
            eventSubscriber.onPayload(DOCUMENTS_EVENT_CHANNELS.menuOpenRecentFile, callback),
        onMenuOpenExternalPaths: (callback: (paths: string[]) => void): IMenuEventUnsubscribe =>
            eventSubscriber.onPayload(DOCUMENTS_EVENT_CHANNELS.menuOpenExternalPaths, callback),
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
