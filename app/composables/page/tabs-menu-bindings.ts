import type { IElectronAPI } from '@app/types/electron-api';
import type { Ref } from 'vue';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TWindowTabsAction } from '@app/types/window-tab-transfer';

interface ITabsMenuBindingDeps {
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    activeTabId: Ref<string | null>;
    createTab: () => { id: string };
    handleCloseTab: (tabId: string) => Promise<void>;
    openPathInAppropriateTab: (path: string) => Promise<void>;
    openPathsInAppropriateTab: (paths: string[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    openSettings: () => void;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TGroupDirection) => Promise<void> | void;
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
    electronApi: IElectronAPI,
    deps: ITabsMenuBindingDeps,
) {
    const api = electronApi as Partial<IElectronAPI>;
    return [
        api.onMenuOpenPdf?.(() => {
            void deps.activeWorkspace.value?.handleOpenFileFromUi();
        }),
        api.onMenuSave?.(() => {
            void deps.activeWorkspace.value?.handleSave();
        }),
        api.onMenuSaveAs?.(() => {
            void deps.activeWorkspace.value?.handleSaveAs();
        }),
        api.onMenuExportDocx?.(() => {
            void deps.activeWorkspace.value?.handleExportDocx();
        }),
        api.onMenuExportImages?.(() => {
            void deps.activeWorkspace.value?.handleExportImages();
        }),
        api.onMenuExportMultiPageTiff?.(() => {
            void deps.activeWorkspace.value?.handleExportMultiPageTiff();
        }),
        api.onMenuUndo?.(() => {
            deps.activeWorkspace.value?.handleUndo();
        }),
        api.onMenuRedo?.(() => {
            deps.activeWorkspace.value?.handleRedo();
        }),
        api.onMenuZoomIn?.(() => {
            deps.activeWorkspace.value?.handleZoomIn();
        }),
        api.onMenuZoomOut?.(() => {
            deps.activeWorkspace.value?.handleZoomOut();
        }),
        api.onMenuActualSize?.(() => {
            deps.activeWorkspace.value?.handleActualSize();
        }),
        api.onMenuFitWidth?.(() => {
            deps.activeWorkspace.value?.handleFitWidth();
        }),
        api.onMenuFitHeight?.(() => {
            deps.activeWorkspace.value?.handleFitHeight();
        }),
        api.onMenuViewModeSingle?.(() => {
            deps.activeWorkspace.value?.handleViewModeSingle();
        }),
        api.onMenuViewModeFacing?.(() => {
            deps.activeWorkspace.value?.handleViewModeFacing();
        }),
        api.onMenuViewModeFacingFirstSingle?.(() => {
            deps.activeWorkspace.value?.handleViewModeFacingFirstSingle();
        }),
        api.onMenuOpenRecentFile?.((path: string) => {
            void deps.openPathInAppropriateTab(path);
        }),
        api.onMenuOpenExternalPaths?.((paths: string[]) => {
            void deps.openPathsInAppropriateTab(paths);
        }),
        api.onMenuClearRecentFiles?.(() => {
            void deps.clearRecentFiles();
            void deps.loadRecentFiles();
        }),
        api.onMenuOpenSettings?.(() => {
            deps.openSettings();
        }),
        api.onMenuCheckForUpdates?.(() => {
            void deps.checkForUpdates();
        }),
        api.onMenuDeletePages?.(() => {
            deps.activeWorkspace.value?.handleDeletePages();
        }),
        api.onMenuExtractPages?.(() => {
            deps.activeWorkspace.value?.handleExtractPages();
        }),
        api.onMenuRotateCw?.(() => {
            deps.activeWorkspace.value?.handleRotateCw();
        }),
        api.onMenuRotateCcw?.(() => {
            deps.activeWorkspace.value?.handleRotateCcw();
        }),
        api.onMenuInsertPages?.(() => {
            deps.activeWorkspace.value?.handleInsertPages();
        }),
        api.onMenuConvertToPdf?.(() => {
            deps.activeWorkspace.value?.handleConvertToPdf();
        }),
        api.onMenuNewTab?.(() => {
            deps.createTab();
        }),
        api.onMenuCloseTab?.(() => {
            if (deps.activeTabId.value) {
                void deps.handleCloseTab(deps.activeTabId.value);
            }
        }),
        api.onMenuSplitEditor?.((direction) => {
            void deps.splitEditor(direction);
        }),
        api.onMenuFocusEditorGroup?.((direction) => {
            deps.focusGroup(direction);
        }),
        api.onMenuMoveTabToGroup?.((direction) => {
            void deps.moveActiveTab(direction);
        }),
        api.onMenuCopyTabToGroup?.((direction) => {
            void deps.copyActiveTab(direction);
        }),
        api.tabs?.onWindowAction((action) => {
            void deps.handleWindowTabsAction(action);
        }),
    ].filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
}
