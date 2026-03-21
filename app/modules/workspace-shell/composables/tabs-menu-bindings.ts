import type {
    IPlatformApi,
    TDocumentRef,
} from '@contracts/platform-api';
import type { Ref } from 'vue';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TWindowTabsAction } from '@contracts/window-tabs';
import { BrowserLogger } from '@app/utils/browser-logger';

interface ITabsMenuBindingDeps {
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    activeTabId: Ref<string | null>;
    createTab: () => { id: string };
    handleCloseTab: (tabId: string) => Promise<void>;
    openPathInAppropriateTab: (path: TDocumentRef) => Promise<void>;
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    openSettings: () => void;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TGroupDirection) => Promise<void> | void;
    splitEditorEmpty: (direction: TGroupDirection) => Promise<void> | void;
    focusGroup: (direction: TGroupDirection) => void;
    moveActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    copyActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
}

/**
 * Registers menu->renderer event handlers and returns unsubscribe callbacks.
 * Uses optional chaining on each binding so a stale preload (dev mode version
 * mismatch) degrades gracefully rather than crashing the renderer.
 */
export function registerTabsMenuBindings(
    electronApi: IPlatformApi,
    deps: ITabsMenuBindingDeps,
) {
    const api = electronApi as Partial<IPlatformApi>;
    let documentOpenQueue: Promise<void> = Promise.resolve();
    let disposed = false;

    const runMenuAction = (actionName: string, action: () => unknown) => {
        try {
            const result = action();
            if (result instanceof Promise) {
                void result.catch((error) => {
                    BrowserLogger.warn('tabs-menu', `Menu action failed: ${actionName}`, error);
                });
            }
        } catch (error) {
            BrowserLogger.warn('tabs-menu', `Menu action threw: ${actionName}`, error);
        }
    };

    const enqueueDocumentOpenAction = (
        actionName: string,
        action: () => Promise<void>,
    ) => {
        if (disposed) {
            return;
        }

        documentOpenQueue = documentOpenQueue.then(async () => {
            if (disposed) {
                return;
            }

            try {
                await action();
            } catch (error) {
                BrowserLogger.warn('tabs-menu', `Queued document open failed: ${actionName}`, error);
            }
        });
    };

    const cleanups = [
        api.documents?.onMenuOpenPdf?.(() => {
            runMenuAction('open-pdf', () => deps.activeWorkspace.value?.handleOpenFileFromUi());
        }),
        api.documents?.onMenuInsertImageFromFile?.(() => {
            runMenuAction('insert-image-from-file', () => deps.activeWorkspace.value?.handleInsertImageFromFile());
        }),
        api.documents?.onMenuPasteImageFromClipboard?.(() => {
            runMenuAction('paste-image-from-clipboard', () => deps.activeWorkspace.value?.handlePasteImageFromClipboard());
        }),
        api.documents?.onMenuSave?.(() => {
            runMenuAction('save', () => deps.activeWorkspace.value?.handleSave());
        }),
        api.documents?.onMenuSaveAs?.(() => {
            runMenuAction('save-as', () => deps.activeWorkspace.value?.handleSaveAs());
        }),
        api.documents?.onMenuExportDocx?.(() => {
            runMenuAction('export-docx', () => deps.activeWorkspace.value?.handleExportDocx());
        }),
        api.documents?.onMenuExportImages?.(() => {
            runMenuAction('export-images', () => deps.activeWorkspace.value?.handleExportImages());
        }),
        api.documents?.onMenuExportMultiPageTiff?.(() => {
            runMenuAction('export-multi-page-tiff', () => deps.activeWorkspace.value?.handleExportMultiPageTiff());
        }),
        api.documents?.onMenuUndo?.(() => {
            runMenuAction('undo', () => deps.activeWorkspace.value?.handleUndo());
        }),
        api.documents?.onMenuRedo?.(() => {
            runMenuAction('redo', () => deps.activeWorkspace.value?.handleRedo());
        }),
        api.documents?.onMenuZoomIn?.(() => {
            runMenuAction('zoom-in', () => deps.activeWorkspace.value?.handleZoomIn());
        }),
        api.documents?.onMenuZoomOut?.(() => {
            runMenuAction('zoom-out', () => deps.activeWorkspace.value?.handleZoomOut());
        }),
        api.documents?.onMenuActualSize?.(() => {
            runMenuAction('actual-size', () => deps.activeWorkspace.value?.handleActualSize());
        }),
        api.documents?.onMenuFitWidth?.(() => {
            runMenuAction('fit-width', () => deps.activeWorkspace.value?.handleFitWidth());
        }),
        api.documents?.onMenuFitHeight?.(() => {
            runMenuAction('fit-height', () => deps.activeWorkspace.value?.handleFitHeight());
        }),
        api.documents?.onMenuViewModeSingle?.(() => {
            runMenuAction('view-mode-single', () => deps.activeWorkspace.value?.handleViewModeSingle());
        }),
        api.documents?.onMenuViewModeFacing?.(() => {
            runMenuAction('view-mode-facing', () => deps.activeWorkspace.value?.handleViewModeFacing());
        }),
        api.documents?.onMenuViewModeFacingFirstSingle?.(() => {
            runMenuAction('view-mode-facing-first-single', () => deps.activeWorkspace.value?.handleViewModeFacingFirstSingle());
        }),
        api.documents?.onMenuOpenRecentFile?.((path: TDocumentRef) => {
            enqueueDocumentOpenAction('open-recent-file', () => deps.openPathInAppropriateTab(path));
        }),
        api.documents?.onMenuOpenExternalPaths?.((paths: TDocumentRef[]) => {
            enqueueDocumentOpenAction('open-external-paths', () => deps.openPathsInAppropriateTab(paths));
        }),
        api.documents?.onMenuClearRecentFiles?.(() => {
            runMenuAction('clear-recent-files', async () => {
                await deps.clearRecentFiles();
                await deps.loadRecentFiles();
            });
        }),
        api.settings?.onMenuOpenSettings?.(() => {
            runMenuAction('open-settings', () => deps.openSettings());
        }),
        api.updates?.onMenuCheckForUpdates?.(() => {
            runMenuAction('check-for-updates', () => deps.checkForUpdates());
        }),
        api.documents?.onMenuDeletePages?.(() => {
            runMenuAction('delete-pages', () => deps.activeWorkspace.value?.handleDeletePages());
        }),
        api.documents?.onMenuExtractPages?.(() => {
            runMenuAction('extract-pages', () => deps.activeWorkspace.value?.handleExtractPages());
        }),
        api.documents?.onMenuRotateCw?.(() => {
            runMenuAction('rotate-cw', () => deps.activeWorkspace.value?.handleRotateCw());
        }),
        api.documents?.onMenuRotateCcw?.(() => {
            runMenuAction('rotate-ccw', () => deps.activeWorkspace.value?.handleRotateCcw());
        }),
        api.documents?.onMenuInsertPages?.(() => {
            runMenuAction('insert-pages', () => deps.activeWorkspace.value?.handleInsertPages());
        }),
        api.djvu?.onMenuConvertToPdf?.(() => {
            runMenuAction('convert-to-pdf', () => deps.activeWorkspace.value?.handleConvertToPdf());
        }),
        api.windowTabs?.onMenuNewTab?.(() => {
            runMenuAction('new-tab', () => deps.createTab());
        }),
        api.windowTabs?.onMenuCloseTab?.(() => {
            runMenuAction('close-tab', () => {
                if (deps.activeTabId.value) {
                    return deps.handleCloseTab(deps.activeTabId.value);
                }
                return undefined;
            });
        }),
        api.windowTabs?.onMenuSplitEditor?.((direction) => {
            runMenuAction('split-editor', () => deps.splitEditor(direction));
        }),
        api.windowTabs?.onMenuFocusEditorGroup?.((direction) => {
            runMenuAction('focus-editor-group', () => deps.focusGroup(direction));
        }),
        api.windowTabs?.onMenuMoveTabToGroup?.((direction) => {
            runMenuAction('move-tab-to-group', () => deps.moveActiveTab(direction));
        }),
        api.windowTabs?.onMenuCopyTabToGroup?.((direction) => {
            runMenuAction('copy-tab-to-group', () => deps.copyActiveTab(direction));
        }),
        api.windowTabs?.onWindowAction((action) => {
            runMenuAction('window-action', () => deps.handleWindowTabsAction(action));
        }),
    ].filter((cleanup): cleanup is () => void => typeof cleanup === 'function');

    return [
        ...cleanups,
        () => {
            disposed = true;
            documentOpenQueue = Promise.resolve();
        },
    ];
}
