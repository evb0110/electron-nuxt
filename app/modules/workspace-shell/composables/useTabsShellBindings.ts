import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browserLogger';
import { traceRendererStartup } from '@app/utils/startupTrace';
import {
    type ITabsMenuBindingDeps,
    registerTabsMenuBindings,
} from '@app/modules/workspace-shell/composables/tabsMenuBindings';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/platformShortcuts';

const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
type TTabKeyboardShortcutAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab';
type TRendererDocumentShortcutAction = 'open-file' | 'save-as' | 'export-docx' | 'undo' | 'redo';
const RENDERER_MENU_SHORTCUT_ACTIONS: Partial<Record<string, TTabKeyboardShortcutAction>> = {
    t: 'new-tab',
    w: 'close-tab',
};

interface IUseTabsShellBindingsOptions extends ITabsMenuBindingDeps {
    tabs: Ref<Array<{ id: string }>>;
    isStartupOpenClaimPending: Ref<boolean>;
    activateTab: (tabId: string) => void;
    beginOpenPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
}

export const useTabsShellBindings = (options: IUseTabsShellBindingsOptions) => {
    const {
        tabs,
        isStartupOpenClaimPending,
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

    function isEditableShortcutTarget(target: EventTarget | null) {
        if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
            return false;
        }

        return Boolean(
            target.isContentEditable
            || target.closest('[contenteditable="true"], [contenteditable=""]')
            || target.closest('input, textarea, select'),
        );
    }

    function resolveRendererDocumentShortcutAction(event: KeyboardEvent): TRendererDocumentShortcutAction | null {
        if (!shouldHandleRendererMenuAccelerators()) {
            return null;
        }

        const mod = event.metaKey || event.ctrlKey;
        if (!mod || event.altKey) {
            return null;
        }

        const key = event.key.toLowerCase();
        if (key === 'o' && !event.shiftKey) {
            return 'open-file';
        }

        if (key === 's' && event.shiftKey) {
            return 'save-as';
        }

        if (key === 'e' && event.shiftKey) {
            return 'export-docx';
        }

        if (key === 'z') {
            if (isEditableShortcutTarget(event.target)) {
                return null;
            }
            return event.shiftKey ? 'redo' : 'undo';
        }

        if (key === 'y' && !event.shiftKey && !isEditableShortcutTarget(event.target)) {
            return 'redo';
        }

        return null;
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

    function runRendererDocumentShortcutAction(action: TRendererDocumentShortcutAction) {
        if (action === 'open-file') {
            void handleFallbackToolbarOpenFile();
            return;
        }

        const workspace = activeWorkspace.value;
        if (action === 'save-as') {
            void workspace?.handleSaveAs();
        } else if (action === 'export-docx') {
            void workspace?.handleExportDocx();
        } else if (action === 'undo') {
            void workspace?.handleUndo();
        } else {
            void workspace?.handleRedo();
        }
    }

    function handleTabKeyboardShortcut(event: KeyboardEvent) {
        const documentAction = resolveRendererDocumentShortcutAction(event);
        if (documentAction) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            runRendererDocumentShortcutAction(documentAction);
            return;
        }

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
        isStartupOpenClaimPending.value = true;
        traceRendererStartup('tabs shell initial tab available', {tabCount: tabs.value.length});

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<boolean> }).__openFileDirect = openPathInAppropriateTab;
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
            isStartupOpenClaimPending.value = false;
            await nextTick();
            traceRendererStartup('tabs shell dispatching app:rendererReady');
            getWindowTabsCapability().notifyRendererReady();
        })().catch((error) => {
            BrowserLogger.warn('tabs-shell', 'Startup externalOpen preparation failed before renderer ready', error);
            dispatchStartupOpenClaimed(0);
            isStartupOpenClaimPending.value = false;
            getWindowTabsCapability().notifyRendererReady();
        });

        traceRendererStartup('tabs shell onMounted finished', {durationMs: Math.round(performance.now() - onMountedStart)});
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined' && (window as Window & { __openFileDirect?: unknown }).__openFileDirect === openPathInAppropriateTab) {
            delete (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<boolean> }).__openFileDirect;
        }
        if (typeof window !== 'undefined' && (window as Window & { __handleSave?: unknown }).__handleSave === debugHandleSave) {
            // Remove debug hooks on unmount so old closures do not retain stale workspace state.
            delete (window as Window & { __handleSave?: () => Promise<void> }).__handleSave;
        }
        menuCleanups.forEach(cleanup => cleanup());
        stopTabKeyboardShortcutListener();
    });
};
