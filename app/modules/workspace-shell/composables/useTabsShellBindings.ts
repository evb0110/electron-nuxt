import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { TWindowTabsAction } from '@contracts/window-tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TDocumentRef } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browser-logger';
import { traceRendererStartup } from '@app/utils/startup-trace';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/composables/tabs-menu-bindings';
import { getWindowTabsCapability } from '@app/utils/platform-window-tabs';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/platform-shortcuts';

interface IUseTabsShellBindingsOptions {
    tabs: Ref<Array<{ id: string }>>;
    activeTabId: Ref<string | null>;
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    createTab: () => { id: string };
    activateTab: (tabId: string) => void;
    handleCloseTab: (tabId: string) => Promise<void>;
    handleFallbackToolbarOpenFile: () => Promise<void>;
    openPathInAppropriateTab: (path: TDocumentRef) => Promise<void>;
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    beginOpenPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
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
        handleFallbackToolbarOpenFile,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
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
        const shouldHandleRendererAccelerators = shouldHandleRendererMenuAccelerators();

        // In Electron these accelerators are handled by the app menu.
        // Keep renderer-level handlers only as a non-Electron fallback.
        if (shouldHandleRendererAccelerators && mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
            event.preventDefault();
            createTab();
            return;
        }

        if (shouldHandleRendererAccelerators && mod && event.key.toLowerCase() === 'w' && !event.shiftKey) {
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

    const stopTabKeyboardShortcutListener = useEventListener(
        typeof window !== 'undefined' ? window : undefined,
        'keydown',
        handleTabKeyboardShortcut,
        {capture: true},
    );

    onMounted(() => {
        const onMountedStart = performance.now();
        const platformApi = getPlatformAPI();
        traceRendererStartup('tabs shell onMounted start');
        ensureAtLeastOneTab();
        traceRendererStartup('tabs shell ensured at least one tab', {tabCount: tabs.value.length});

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<void> }).__openFileDirect = openPathInAppropriateTab;
            (window as Window & { __handleSave?: () => Promise<void> }).__handleSave = debugHandleSave;
        }

        menuCleanups.push(...registerTabsMenuBindings(platformApi, {
            activeWorkspace,
            activeTabId,
            createTab,
            handleCloseTab,
            handleFallbackToolbarOpenFile,
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

        void (async () => {
            const startupExternalPaths = await getWindowTabsCapability().claimPendingExternalOpenPaths();
            if (startupExternalPaths.length > 0) {
                traceRendererStartup('tabs shell claimed startup external paths', {pathCount: startupExternalPaths.length});
                await beginOpenPathsInAppropriateTab(startupExternalPaths);
            }
            await nextTick();
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            getWindowTabsCapability().notifyRendererReady();
        })().catch((error) => {
            BrowserLogger.warn('tabs-shell', 'Startup external-open preparation failed before renderer ready', error);
            getWindowTabsCapability().notifyRendererReady();
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
        stopTabKeyboardShortcutListener();
    });
}
