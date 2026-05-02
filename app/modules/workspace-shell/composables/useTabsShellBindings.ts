import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browser-logger';
import { traceRendererStartup } from '@app/utils/startup-trace';
import {
    type ITabsMenuBindingDeps,
    registerTabsMenuBindings,
} from '@app/modules/workspace-shell/composables/tabs-menu-bindings';
import { getWindowTabsCapability } from '@app/utils/platform-window-tabs';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/platform-shortcuts';

const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
type TTabKeyboardShortcutAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab';
const RENDERER_MENU_SHORTCUT_ACTIONS: Partial<Record<string, TTabKeyboardShortcutAction>> = {
    t: 'new-tab',
    w: 'close-tab',
};

interface IUseTabsShellBindingsOptions extends ITabsMenuBindingDeps {
    tabs: Ref<Array<{ id: string }>>;
    activateTab: (tabId: string) => void;
    beginOpenPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    ensureAtLeastOneTab: () => void;
}

export const useTabsShellBindings = (options: IUseTabsShellBindingsOptions) => {
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
        focusGroup,
        moveActiveTab,
        copyActiveTab,
        handleWindowTabsAction,
    } = options;

    const menuCleanups: Array<() => void> = [];
    const debugHandleSave = () => activeWorkspace.value?.handleSave() ?? Promise.resolve();

    function dispatchStartupOpenClaimed(pathCount: number) {
        if (typeof window === 'undefined') {
            return;
        }

        window.dispatchEvent(new CustomEvent(STARTUP_OPEN_CLAIMED_EVENT_NAME, {detail: { pathCount }}));
    }

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

    function resolveRendererMenuShortcutAction(event: KeyboardEvent) {
        const mod = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();
        return mod && !event.shiftKey
            ? RENDERER_MENU_SHORTCUT_ACTIONS[key] ?? null
            : null;
    }

    function resolveCtrlTabShortcutAction(event: KeyboardEvent): TTabKeyboardShortcutAction | null {
        if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
            return 'next-tab';
        }

        if (event.ctrlKey && event.key === 'Tab' && event.shiftKey) {
            return 'previous-tab';
        }

        return null;
    }

    function resolveTabKeyboardShortcutAction(event: KeyboardEvent): TTabKeyboardShortcutAction | null {
        // In Electron these accelerators are handled by the app menu.
        // Keep renderer-level handlers only as a non-Electron fallback.
        if (shouldHandleRendererMenuAccelerators()) {
            const rendererAction = resolveRendererMenuShortcutAction(event);
            if (rendererAction) {
                return rendererAction;
            }
        }

        return resolveCtrlTabShortcutAction(event);
    }

    function runTabKeyboardShortcutAction(action: TTabKeyboardShortcutAction) {
        if (action === 'new-tab') {
            createTab();
        } else if (action === 'close-tab') {
            if (activeTabId.value) {
                void handleCloseTab(activeTabId.value);
            }
        } else {
            cycleTab(action === 'next-tab' ? 1 : -1);
        }
    }

    function handleTabKeyboardShortcut(event: KeyboardEvent) {
        const action = resolveTabKeyboardShortcutAction(event);
        if (!action) {
            return;
        }

        event.preventDefault();
        runTabKeyboardShortcutAction(action);
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
            focusGroup,
            moveActiveTab,
            copyActiveTab,
            handleWindowTabsAction,
        }));
        traceRendererStartup('tabs shell menu bindings registered');

        void (async () => {
            const startupExternalPaths = await getWindowTabsCapability().claimPendingExternalOpenPaths();
            dispatchStartupOpenClaimed(startupExternalPaths.length);
            if (startupExternalPaths.length > 0) {
                traceRendererStartup('tabs shell claimed startup external paths', {pathCount: startupExternalPaths.length});
                await beginOpenPathsInAppropriateTab(startupExternalPaths);
            }
            await nextTick();
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            getWindowTabsCapability().notifyRendererReady();
        })().catch((error) => {
            BrowserLogger.warn('tabs-shell', 'Startup external-open preparation failed before renderer ready', error);
            dispatchStartupOpenClaimed(0);
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
};
