import type { IElectronAPI } from '@contracts/electron-api';
import type { Ref } from 'vue';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TWindowTabsAction } from '@contracts/window-tabs';

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
        api.documents?.onMenuOpenPdf?.(() => {
            void deps.activeWorkspace.value?.handleOpenFileFromUi();
        }),
        api.documents?.onMenuSave?.(() => {
            void deps.activeWorkspace.value?.handleSave();
        }),
        api.documents?.onMenuSaveAs?.(() => {
            void deps.activeWorkspace.value?.handleSaveAs();
        }),
        api.documents?.onMenuExportDocx?.(() => {
            void deps.activeWorkspace.value?.handleExportDocx();
        }),
        api.documents?.onMenuExportImages?.(() => {
            void deps.activeWorkspace.value?.handleExportImages();
        }),
        api.documents?.onMenuExportMultiPageTiff?.(() => {
            void deps.activeWorkspace.value?.handleExportMultiPageTiff();
        }),
        api.documents?.onMenuUndo?.(() => {
            deps.activeWorkspace.value?.handleUndo();
        }),
        api.documents?.onMenuRedo?.(() => {
            deps.activeWorkspace.value?.handleRedo();
        }),
        api.documents?.onMenuZoomIn?.(() => {
            deps.activeWorkspace.value?.handleZoomIn();
        }),
        api.documents?.onMenuZoomOut?.(() => {
            deps.activeWorkspace.value?.handleZoomOut();
        }),
        api.documents?.onMenuActualSize?.(() => {
            deps.activeWorkspace.value?.handleActualSize();
        }),
        api.documents?.onMenuFitWidth?.(() => {
            deps.activeWorkspace.value?.handleFitWidth();
        }),
        api.documents?.onMenuFitHeight?.(() => {
            deps.activeWorkspace.value?.handleFitHeight();
        }),
        api.documents?.onMenuViewModeSingle?.(() => {
            deps.activeWorkspace.value?.handleViewModeSingle();
        }),
        api.documents?.onMenuViewModeFacing?.(() => {
            deps.activeWorkspace.value?.handleViewModeFacing();
        }),
        api.documents?.onMenuViewModeFacingFirstSingle?.(() => {
            deps.activeWorkspace.value?.handleViewModeFacingFirstSingle();
        }),
        api.documents?.onMenuOpenRecentFile?.((path: string) => {
            void deps.openPathInAppropriateTab(path);
        }),
        api.documents?.onMenuOpenExternalPaths?.((paths: string[]) => {
            void deps.openPathsInAppropriateTab(paths);
        }),
        api.documents?.onMenuClearRecentFiles?.(() => {
            void deps.clearRecentFiles();
            void deps.loadRecentFiles();
        }),
        api.settings?.onMenuOpenSettings?.(() => {
            deps.openSettings();
        }),
        api.updates?.onMenuCheckForUpdates?.(() => {
            void deps.checkForUpdates();
        }),
        api.documents?.onMenuDeletePages?.(() => {
            deps.activeWorkspace.value?.handleDeletePages();
        }),
        api.documents?.onMenuExtractPages?.(() => {
            deps.activeWorkspace.value?.handleExtractPages();
        }),
        api.documents?.onMenuRotateCw?.(() => {
            deps.activeWorkspace.value?.handleRotateCw();
        }),
        api.documents?.onMenuRotateCcw?.(() => {
            deps.activeWorkspace.value?.handleRotateCcw();
        }),
        api.documents?.onMenuInsertPages?.(() => {
            deps.activeWorkspace.value?.handleInsertPages();
        }),
        api.djvu?.onMenuConvertToPdf?.(() => {
            deps.activeWorkspace.value?.handleConvertToPdf();
        }),
        api.windowTabs?.onMenuNewTab?.(() => {
            deps.createTab();
        }),
        api.windowTabs?.onMenuCloseTab?.(() => {
            if (deps.activeTabId.value) {
                void deps.handleCloseTab(deps.activeTabId.value);
            }
        }),
        api.windowTabs?.onMenuSplitEditor?.((direction) => {
            void deps.splitEditor(direction);
        }),
        api.windowTabs?.onMenuFocusEditorGroup?.((direction) => {
            deps.focusGroup(direction);
        }),
        api.windowTabs?.onMenuMoveTabToGroup?.((direction) => {
            void deps.moveActiveTab(direction);
        }),
        api.windowTabs?.onMenuCopyTabToGroup?.((direction) => {
            void deps.copyActiveTab(direction);
        }),
        api.windowTabs?.onWindowAction((action) => {
            void deps.handleWindowTabsAction(action);
        }),
    ].filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
}
