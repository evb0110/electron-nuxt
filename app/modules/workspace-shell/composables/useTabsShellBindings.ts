import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IEvbTestCommandResult,
    IEvbTestApi,
    IEvbTestWorkspaceDebugState,
} from '@app/types/evbTestApi';
import type {
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import {
    getPlatformAPI,
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browserLogger';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import type { ITabsMenuBindingDeps } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/shouldHandleRendererMenuAccelerators';

const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
type TTabKeyboardShortcutAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab';
type TRendererDocumentShortcutAction = 'open-file' | 'save-as' | 'export-docx' | 'undo' | 'redo';
const RENDERER_MENU_SHORTCUT_ACTIONS: Partial<Record<string, TTabKeyboardShortcutAction>> = {
    t: 'new-tab',
    w: 'close-tab',
};

interface IUseTabsShellBindingsOptions extends ITabsMenuBindingDeps {
    tabs: Ref<Array<{ id: string }>>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    isStartupOpenClaimPending: Ref<boolean>;
    activateTab: (tabId: string) => void;
    beginOpenPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
}

export const useTabsShellBindings = (options: IUseTabsShellBindingsOptions) => {
    const route = useRoute();
    const {
        tabs,
        workspaceRefs,
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
        focusPane,
        moveActiveTab,
        copyActiveTab,
        handleWindowTabsAction,
        toggleAssistant,
    } = options;

    const menuCleanups: Array<() => void> = [];
    const debugHandleSave = () => activeWorkspace.value?.handleSave() ?? Promise.resolve();
    let installedTestApi: IEvbTestApi | null = null;

    function isAutomationTestApiEnabled() {
        return typeof window !== 'undefined'
            && typeof window.__allowRendererFileOpenForAutomation === 'function';
    }

    function readWorkspaceSnapshot(workspace: IWorkspaceExpose | null): IWorkspaceToolbarSnapshot | null {
        try {
            return workspace?.getToolbarSnapshot() ?? null;
        } catch (error) {
            BrowserLogger.warn('tabs-shell', 'Failed to read workspace toolbar snapshot for automation API', error);
            return null;
        }
    }

    function readWorkspaceAutomationState(
        workspace: IWorkspaceExpose | null,
    ): IWorkspaceAutomationStateSnapshot | Record<string, never> {
        try {
            return workspace?.getAutomationStateSnapshot() ?? {};
        } catch (error) {
            BrowserLogger.warn('tabs-shell', 'Failed to read workspace automation state', error);
            return {};
        }
    }

    function unwrapAutomationValue(value: unknown) {
        const unwrapped = value
        && typeof value === 'object'
        && 'value' in value
            ? (value as { value?: unknown }).value
            : value;
        return unwrapped instanceof Set ? Array.from(unwrapped) : unwrapped;
    }

    function createEvbTestApi(): IEvbTestApi {
        const getActiveWorkspaceHandle = () => activeWorkspace.value;

        function readActiveWorkspaceStateValues<TValues extends Record<string, unknown> = Record<string, unknown>>(
            propertyNames: string[],
        ): TValues {
            const workspace = getActiveWorkspaceHandle();
            const automationState = readWorkspaceAutomationState(workspace) as Record<string, unknown>;
            const workspaceRecord = workspace as Record<string, unknown> | null;
            const values: Record<string, unknown> = {};

            for (const propertyName of propertyNames) {
                if (propertyName in automationState) {
                    values[propertyName] = automationState[propertyName];
                    continue;
                }

                values[propertyName] = unwrapAutomationValue(workspaceRecord?.[propertyName]);
            }

            return values as TValues;
        }

        const callActiveWorkspaceCommand = async <TResult = unknown>(
            commandName: string,
            args: unknown[] = [],
        ): Promise<IEvbTestCommandResult<TResult>> => {
            const workspace = getActiveWorkspaceHandle();
            const command = (workspace as Record<string, unknown> | null)?.[commandName];
            if (typeof command !== 'function') {
                return {
                    called: false,
                    value: null,
                };
            }

            const value = await Promise.resolve((command as (...values: unknown[]) => unknown).apply(workspace, args));
            return {
                called: true,
                value: (value ?? null) as TResult | null,
            };
        };

        return {
            openFile: openPathInAppropriateTab,
            openFiles: openPathsInAppropriateTab,
            getActiveTabId: () => activeTabId.value,
            getActiveWorkspaceHandle,
            getActiveToolbarSnapshot: () => readWorkspaceSnapshot(getActiveWorkspaceHandle()),
            readActiveWorkspaceStateValues,
            callActiveWorkspaceCommand,
            collectWorkspaceDebugState: (): IEvbTestWorkspaceDebugState => {
                const activeWorkspaceHandle = getActiveWorkspaceHandle();
                return {
                    activeTabId: activeTabId.value,
                    activeToolbarSnapshot: readWorkspaceSnapshot(activeWorkspaceHandle),
                    activeWorkspaceState: readWorkspaceAutomationState(activeWorkspaceHandle),
                    workspaceCount: workspaceRefs.value.size,
                    workspaces: Array.from(
                        workspaceRefs.value.entries(),
                    ).map(([
                        tabId,
                        workspace,
                    ]) => ({
                        automationStateKeys: Object.keys(readWorkspaceAutomationState(workspace)),
                        exposedKeys: Object.keys(workspace),
                        isActive: tabId === activeTabId.value,
                        tabId,
                        toolbarSnapshot: readWorkspaceSnapshot(workspace),
                    })),
                };
            },
            waitForActiveDocumentOpenSettled: async () => {
                const workspace = getActiveWorkspaceHandle();
                if (!workspace) {
                    return false;
                }
                await workspace.waitForDocumentOpenSettled();
                return true;
            },
        };
    }

    function installAutomationTestApi() {
        if (!isAutomationTestApiEnabled()) {
            return;
        }

        installedTestApi = createEvbTestApi();
        window.__evbTestApi = installedTestApi;
    }

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
            target.isContentEditable === true
            || Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'))
            || Boolean(target.closest('input, textarea, select')),
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
        traceRendererStartup('tabs shell onMounted start');
        isStartupOpenClaimPending.value = true;
        traceRendererStartup('tabs shell initial tab available', {tabCount: tabs.value.length});

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: TDocumentRef) => Promise<boolean> }).__openFileDirect = openPathInAppropriateTab;
            (window as Window & { __handleSave?: () => Promise<unknown> }).__handleSave = debugHandleSave;
            installAutomationTestApi();
        }

        void (async () => {
            const shouldWaitForDesktopBridge = shouldPreferDesktopPlatform(route.path);
            const bridgeReady = await waitForDesktopPlatformBridge({shouldWait: shouldWaitForDesktopBridge});
            traceRendererStartup('tabs shell platform bridge resolved', {
                bridgeReady,
                routePath: route.path,
                shouldWaitForDesktopBridge,
            });

            const platformApi = getPlatformAPI();
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
                focusPane,
                moveActiveTab,
                copyActiveTab,
                handleWindowTabsAction,
                toggleAssistant,
            }));
            traceRendererStartup('tabs shell menu bindings registered');

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
            delete (window as Window & { __handleSave?: () => Promise<unknown> }).__handleSave;
        }
        if (typeof window !== 'undefined' && window.__evbTestApi === installedTestApi) {
            delete window.__evbTestApi;
        }
        menuCleanups.forEach(cleanup => cleanup());
        stopTabKeyboardShortcutListener();
    });
};
