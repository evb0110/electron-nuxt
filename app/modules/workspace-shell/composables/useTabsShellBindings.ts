import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { TWindowTabsAction } from '@contracts/window-tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TDocumentRef } from '@contracts/platform-api';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/platform';
import { traceRendererStartup } from '@app/utils/startup-trace';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/composables/tabs-menu-bindings';

interface IUseTabsShellBindingsOptions {
    tabs: Ref<Array<{ id: string }>>;
    activeTabId: Ref<string | null>;
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    createTab: () => { id: string };
    activateTab: (tabId: string) => void;
    handleCloseTab: (tabId: string) => Promise<void>;
    openPathInAppropriateTab: (path: TDocumentRef) => Promise<void>;
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    ensureAtLeastOneTab: () => void;
    openSettings: () => void;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TGroupDirection) => Promise<void> | void;
    splitEditorEmpty: (direction: TGroupDirection) => Promise<void> | void;
    focusGroup: (direction: TGroupDirection) => void;
    moveActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    copyActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
}

export function useTabsShellBindings(options: IUseTabsShellBindingsOptions) {
    const {
        tabs,
        activeTabId,
        activeWorkspace,
        createTab,
        activateTab,
        handleCloseTab,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        clearRecentFiles,
        loadRecentFiles,
        ensureAtLeastOneTab,
        openSettings,
        checkForUpdates,
        splitEditor,
        splitEditorEmpty,
        focusGroup,
        moveActiveTab,
        copyActiveTab,
        handleWindowTabsAction,
    } = options;

    const menuCleanups: Array<() => void> = [];
    const windowListenerCleanups: Array<() => void> = [];
    const debugHandleSave = () => activeWorkspace.value?.handleSave() ?? Promise.resolve();

    function cycleTab(direction: number) {
        if (tabs.value.length <= 1 || !activeTabId.value) {
            return;
        }
        const currentIndex = tabs.value.findIndex(t => t.id === activeTabId.value);
        if (currentIndex < 0) {
            return;
        }
        const nextIndex = (currentIndex + direction + tabs.value.length) % tabs.value.length;
        const nextTab = tabs.value[nextIndex];
        if (nextTab) {
            activateTab(nextTab.id);
        }
    }

    function handleTabKeyboardShortcut(event: KeyboardEvent) {
        const mod = event.metaKey || event.ctrlKey;

        // In Electron these accelerators are handled by the app menu.
        // Keep renderer-level handlers only as a non-Electron fallback.
        if (!hasElectronAPI() && mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
            event.preventDefault();
            createTab();
            return;
        }

        if (!hasElectronAPI() && mod && event.key.toLowerCase() === 'w' && !event.shiftKey) {
            event.preventDefault();
            if (activeTabId.value) {
                void handleCloseTab(activeTabId.value);
            }
            return;
        }

        if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            cycleTab(1);
            return;
        }

        if (event.ctrlKey && event.key === 'Tab' && event.shiftKey) {
            event.preventDefault();
            cycleTab(-1);
        }
    }

    onMounted(() => {
        const onMountedStart = performance.now();
        const electronApi = getElectronAPI();
        traceRendererStartup('tabs shell onMounted start');
        ensureAtLeastOneTab();
        traceRendererStartup('tabs shell ensured at least one tab', {tabCount: tabs.value.length});
        windowListenerCleanups.push(useEventListener(window, 'keydown', handleTabKeyboardShortcut, {capture: true}));

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<void> }).__openFileDirect = openPathInAppropriateTab;
            (window as Window & { __handleSave?: () => Promise<void> }).__handleSave = debugHandleSave;
        }

        menuCleanups.push(...registerTabsMenuBindings(electronApi, {
            activeWorkspace,
            activeTabId,
            createTab,
            handleCloseTab,
            openPathInAppropriateTab,
            openPathsInAppropriateTab,
            clearRecentFiles,
            loadRecentFiles,
            openSettings,
            checkForUpdates,
            splitEditor,
            splitEditorEmpty,
            focusGroup,
            moveActiveTab,
            copyActiveTab,
            handleWindowTabsAction,
        }));
        traceRendererStartup('tabs shell menu bindings registered');
        void nextTick(() => {
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            electronApi.windowTabs.notifyRendererReady();
        });

        traceRendererStartup('tabs shell onMounted finished', {durationMs: Math.round(performance.now() - onMountedStart)});
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined' && (window as Window & { __openFileDirect?: unknown }).__openFileDirect === openPathInAppropriateTab) {
            delete (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<void> }).__openFileDirect;
        }
        if (typeof window !== 'undefined' && (window as Window & { __handleSave?: unknown }).__handleSave === debugHandleSave) {
            // Remove debug hooks on unmount so old closures do not retain stale workspace state.
            delete (window as Window & { __handleSave?: () => Promise<void> }).__handleSave;
        }
        menuCleanups.forEach(cleanup => cleanup());
        windowListenerCleanups.forEach(cleanup => cleanup());
    });
}
