import type {
    IPlatformApi,
    TDocumentRef,
} from '@contracts/platformApi';
import type { Ref } from 'vue';
import type { TPaneDirection } from '@app/types/editorPanes';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';

export interface ITabsMenuBindingDeps {
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    activeTabId: Ref<string | null>;
    createTab: () => { id: string };
    handleCloseTab: (tabId: string) => Promise<void>;
    handleFallbackToolbarOpenFile: () => Promise<void>;
    openPathInAppropriateTab: (path: TDocumentRef) => Promise<boolean>;
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    openSettings: () => void;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TPaneDirection) => Promise<void> | void;
    focusPane: (direction: TPaneDirection) => void;
    moveActiveTab: (direction: TPaneDirection) => Promise<void> | void;
    copyActiveTab: (direction: TPaneDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
    toggleAssistant: () => void;
}

type TCleanup = () => void;
type TMenuRunAction = (actionName: string, action: () => unknown) => void;
type TNoArgMenuRegister = (handler: () => void) => unknown;
type TDocumentMenuApi = NonNullable<IPlatformApi['documents']>;
interface IDocumentMenuAction {
    name: string;
    register: keyof TDocumentMenuApi;
    run: (deps: ITabsMenuBindingDeps) => unknown;
}

const documentMenuActions: IDocumentMenuAction[] = [
    {
        name: 'open-pdf',
        register: 'onMenuOpenPdf',
        run: deps => deps.handleFallbackToolbarOpenFile(),
    },
    {
        name: 'insert-image-from-file',
        register: 'onMenuInsertImageFromFile',
        run: deps => deps.activeWorkspace.value?.handleInsertImageFromFile(),
    },
    {
        name: 'paste-image-from-clipboard',
        register: 'onMenuPasteImageFromClipboard',
        run: deps => deps.activeWorkspace.value?.handlePasteImageFromClipboard(),
    },
    {
        name: 'save',
        register: 'onMenuSave',
        run: deps => deps.activeWorkspace.value?.handleSave(),
    },
    {
        name: 'repair-save',
        register: 'onMenuRepairSave',
        run: deps => deps.activeWorkspace.value?.handleRepairSave(),
    },
    {
        name: 'save-as',
        register: 'onMenuSaveAs',
        run: deps => deps.activeWorkspace.value?.handleSaveAs(),
    },
    {
        name: 'print',
        register: 'onMenuPrint',
        run: deps => deps.activeWorkspace.value?.handlePrint(),
    },
    {
        name: 'print-current-page',
        register: 'onMenuPrintCurrentPage',
        run: deps => deps.activeWorkspace.value?.handlePrintCurrentPage(),
    },
    {
        name: 'export-docx',
        register: 'onMenuExportDocx',
        run: deps => deps.activeWorkspace.value?.handleExportDocx(),
    },
    {
        name: 'export-images',
        register: 'onMenuExportImages',
        run: deps => deps.activeWorkspace.value?.handleExportImages(),
    },
    {
        name: 'export-multi-page-tiff',
        register: 'onMenuExportMultiPageTiff',
        run: deps => deps.activeWorkspace.value?.handleExportMultiPageTiff(),
    },
    {
        name: 'undo',
        register: 'onMenuUndo',
        run: deps => deps.activeWorkspace.value?.handleUndo(),
    },
    {
        name: 'redo',
        register: 'onMenuRedo',
        run: deps => deps.activeWorkspace.value?.handleRedo(),
    },
    {
        name: 'zoom-in',
        register: 'onMenuZoomIn',
        run: deps => deps.activeWorkspace.value?.handleZoomIn(),
    },
    {
        name: 'zoom-out',
        register: 'onMenuZoomOut',
        run: deps => deps.activeWorkspace.value?.handleZoomOut(),
    },
    {
        name: 'actual-size',
        register: 'onMenuActualSize',
        run: deps => deps.activeWorkspace.value?.handleActualSize(),
    },
    {
        name: 'fit-width',
        register: 'onMenuFitWidth',
        run: deps => deps.activeWorkspace.value?.handleFitWidth(),
    },
    {
        name: 'fit-height',
        register: 'onMenuFitHeight',
        run: deps => deps.activeWorkspace.value?.handleFitHeight(),
    },
    {
        name: 'view-mode-single',
        register: 'onMenuViewModeSingle',
        run: deps => deps.activeWorkspace.value?.handleViewModeSingle(),
    },
    {
        name: 'view-mode-facing',
        register: 'onMenuViewModeFacing',
        run: deps => deps.activeWorkspace.value?.handleViewModeFacing(),
    },
    {
        name: 'view-mode-facing-first-single',
        register: 'onMenuViewModeFacingFirstSingle',
        run: deps => deps.activeWorkspace.value?.handleViewModeFacingFirstSingle(),
    },
    {
        name: 'delete-pages',
        register: 'onMenuDeletePages',
        run: deps => deps.activeWorkspace.value?.handleDeletePages(),
    },
    {
        name: 'extract-pages',
        register: 'onMenuExtractPages',
        run: deps => deps.activeWorkspace.value?.handleExtractPages(),
    },
    {
        name: 'rotate-cw',
        register: 'onMenuRotateCw',
        run: deps => deps.activeWorkspace.value?.handleRotateCw(),
    },
    {
        name: 'rotate-ccw',
        register: 'onMenuRotateCcw',
        run: deps => deps.activeWorkspace.value?.handleRotateCcw(),
    },
    {
        name: 'insert-pages',
        register: 'onMenuInsertPages',
        run: deps => deps.activeWorkspace.value?.handleInsertPages(),
    },
];

function toCleanup(value: unknown): TCleanup | null {
    return typeof value === 'function' ? value as TCleanup : null;
}

function getNoArgDocumentMenuRegister(
    documents: Partial<TDocumentMenuApi> | undefined,
    key: keyof TDocumentMenuApi,
): TNoArgMenuRegister | null {
    const register = documents?.[key];
    return typeof register === 'function' ? register as TNoArgMenuRegister : null;
}

function registerDocumentMenuActions(
    documents: Partial<TDocumentMenuApi> | undefined,
    deps: ITabsMenuBindingDeps,
    runMenuAction: TMenuRunAction,
) {
    return documentMenuActions
        .map((binding) => {
            const register = getNoArgDocumentMenuRegister(documents, binding.register);
            return register?.(() => {
                runMenuAction(binding.name, () => binding.run(deps));
            });
        })
        .map(toCleanup)
        .filter((cleanup): cleanup is TCleanup => Boolean(cleanup));
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
        action: () => Promise<unknown>,
    ) => {
        if (disposed) {
            return;
        }

        documentOpenQueue = documentOpenQueue
            .catch((error) => {
                BrowserLogger.warn('tabs-menu', 'Recovered poisoned document-open queue', error);
            })
            .then(async () => {
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
        ...registerDocumentMenuActions(api.documents, deps, runMenuAction),
        api.documents?.onMenuOpenRecentFile?.((path) => {
            enqueueDocumentOpenAction('open-recent-file', () => deps.openPathInAppropriateTab(path));
        }),
        api.documents?.onMenuOpenExternalPaths?.((paths) => {
            enqueueDocumentOpenAction('open-external-paths', () => deps.openPathsInAppropriateTab(paths));
        }),
        api.documents?.onMenuClearRecentFiles?.(() => {
            runMenuAction('clear-recentFiles', async () => {
                await deps.clearRecentFiles();
                await deps.loadRecentFiles();
            });
        }),
        api.settings?.onMenuOpenSettings?.(() => {
            runMenuAction('open-settings', () => deps.openSettings());
        }),
        api.documents?.onMenuToggleAssistant?.(() => {
            runMenuAction('toggle-assistant', () => deps.toggleAssistant());
        }),
        api.updates?.onMenuCheckForUpdates?.(() => {
            runMenuAction('check-for-updates', () => deps.checkForUpdates());
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
        api.windowTabs?.onMenuFocusEditorPane?.((direction) => {
            runMenuAction('focus-editor-pane', () => deps.focusPane(direction));
        }),
        api.windowTabs?.onMenuMoveTabToPane?.((direction) => {
            runMenuAction('move-tab-to-pane', () => deps.moveActiveTab(direction));
        }),
        api.windowTabs?.onMenuCopyTabToPane?.((direction) => {
            runMenuAction('copy-tab-to-pane', () => deps.copyActiveTab(direction));
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
