import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TSplitPayload } from '@contracts/windowTabs';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import type { TTabUpdate } from '@app/types/tabs';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';

interface IDocumentOpenIntent {
    action: string;
    target?: TTabUpdate | null;
}

interface ICreateDeferredWorkspaceExposeProxyDeps {
    enqueueDocumentOpen: <T>(
        intent: IDocumentOpenIntent,
        run: () => Promise<T>,
    ) => Promise<T | false>;
    getMounted: () => IWorkspaceExpose | null;
    log: (action: string, error: unknown) => void;
    openPath?: ((path: TDocumentRef, action: string) => Promise<boolean>) | undefined;
    overrides?: Partial<IWorkspaceExpose> | undefined;
    withLoadedWorkspace: <T>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) => Promise<T | null | undefined>;
    withLoadedWorkspaceRequired: <T>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) => Promise<T>;
    withWorkspace: (
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<boolean | undefined> | boolean | undefined,
    ) => Promise<boolean>;
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function createDeferredWorkspaceExposeProxy(
    deps: ICreateDeferredWorkspaceExposeProxyDeps,
): IWorkspaceExpose {
    function mountWaitBoolean(
        action: keyof IWorkspaceExpose,
        run: (workspace: IWorkspaceExpose) => Promise<boolean> | boolean,
    ) {
        return async () => await deps.withLoadedWorkspace(action, run) === true;
    }

    function mountWaitVoid(
        action: keyof IWorkspaceExpose,
        run: (workspace: IWorkspaceExpose) => Promise<void> | void,
    ) {
        return async () => {
            await deps.withLoadedWorkspace(action, run);
        };
    }

    function mountWaitSyncVoid(
        action: keyof IWorkspaceExpose,
        run: (workspace: IWorkspaceExpose) => void,
    ) {
        return () => {
            void deps.withLoadedWorkspace(action, run);
        };
    }

    async function directBoolean(
        action: keyof IWorkspaceExpose,
        run: (workspace: IWorkspaceExpose) => Promise<boolean> | boolean,
    ) {
        const workspace = deps.getMounted();
        if (!workspace) {
            return false;
        }
        try {
            return await run(workspace);
        } catch (error) {
            deps.log(action, error);
            return false;
        }
    }

    async function openQueued<T>(
        intent: IDocumentOpenIntent,
        run: () => Promise<T>,
    ) {
        return deps.enqueueDocumentOpen(intent, run);
    }

    const proxy: IWorkspaceExpose = {
        handleSave: mountWaitBoolean('handleSave', workspace => workspace.handleSave()),
        handleRepairSave: mountWaitBoolean('handleRepairSave', workspace => workspace.handleRepairSave()),
        handleOptimizePdfForInteraction: mountWaitBoolean(
            'handleOptimizePdfForInteraction',
            workspace => workspace.handleOptimizePdfForInteraction(),
        ),
        handleSaveAs: mountWaitBoolean('handleSaveAs', workspace => workspace.handleSaveAs()),
        handlePrint: mountWaitVoid('handlePrint', workspace => workspace.handlePrint()),
        handlePrintCurrentPage: mountWaitVoid('handlePrintCurrentPage', workspace => workspace.handlePrintCurrentPage()),
        handleUndo: mountWaitSyncVoid('handleUndo', workspace => workspace.handleUndo()),
        handleRedo: mountWaitSyncVoid('handleRedo', workspace => workspace.handleRedo()),
        handleOpenFileFromUi: () => Promise.resolve(false),
        handleCombineImages: () => directBoolean('handleCombineImages', workspace => workspace.handleCombineImages()),
        handleOpenFileDirectWithPersist: async (path: TDocumentRef) => openQueued({
            action: 'handleOpenFileDirectWithPersist',
            target: buildPendingTabDocumentHint(path),
        }, async () => {
            if (deps.openPath) {
                return deps.openPath(path, 'handleOpenFileDirectWithPersist');
            }

            return deps.withWorkspace(
                'handleOpenFileDirectWithPersist',
                workspace => workspace.handleOpenFileDirectWithPersist(path),
            );
        }),
        handleOpenFileDirectBatchWithPersist: async (paths: TDocumentRef[]) => openQueued({
            action: 'handleOpenFileDirectBatchWithPersist',
            target: null,
        }, async () => deps.withWorkspace(
            'handleOpenFileDirectBatchWithPersist',
            workspace => workspace.handleOpenFileDirectBatchWithPersist(paths),
        )),
        handleOpenFileWithResult: async (result: TOpenFileResult) => openQueued({
            action: 'handleOpenFileWithResult',
            target: buildPendingTabDocumentHint(result),
        }, async () => deps.withWorkspace(
            'handleOpenFileWithResult',
            workspace => workspace.handleOpenFileWithResult(result),
        )),
        handleCloseFileFromUi: async options => (
            await deps.withLoadedWorkspace(
                'handleCloseFileFromUi',
                workspace => workspace.handleCloseFileFromUi(options),
            ) ?? false
        ),
        openRecentFile: async (file: IRecentFile) => openQueued({
            action: 'openRecentFile',
            target: buildPendingTabDocumentHint(file),
        }, async () => deps.withWorkspace('openRecentFile', workspace => workspace.openRecentFile(file))),
        handleExportDocx: mountWaitVoid('handleExportDocx', workspace => workspace.handleExportDocx()),
        handleExportImages: mountWaitVoid('handleExportImages', workspace => workspace.handleExportImages()),
        handleExportMultiPageTiff: mountWaitVoid('handleExportMultiPageTiff', workspace => workspace.handleExportMultiPageTiff()),
        hasPdf: false,
        handleZoomIn: mountWaitSyncVoid('handleZoomIn', workspace => workspace.handleZoomIn()),
        handleZoomOut: mountWaitSyncVoid('handleZoomOut', workspace => workspace.handleZoomOut()),
        handleFitWidth: mountWaitSyncVoid('handleFitWidth', workspace => workspace.handleFitWidth()),
        handleFitHeight: mountWaitSyncVoid('handleFitHeight', workspace => workspace.handleFitHeight()),
        handleActualSize: mountWaitSyncVoid('handleActualSize', workspace => workspace.handleActualSize()),
        setCustomZoomFromDisplay: (displayZoom: number) => {
            void deps.withLoadedWorkspace('setCustomZoomFromDisplay', workspace => workspace.setCustomZoomFromDisplay(displayZoom));
        },
        handleGoToPage: (page: number) => {
            void deps.withLoadedWorkspace('handleGoToPage', workspace => workspace.handleGoToPage(page));
        },
        handleToggleSidebar: mountWaitSyncVoid('handleToggleSidebar', workspace => workspace.handleToggleSidebar()),
        handleToggleContinuousScroll: mountWaitSyncVoid('handleToggleContinuousScroll', workspace => workspace.handleToggleContinuousScroll()),
        handleEnableDragMode: mountWaitSyncVoid('handleEnableDragMode', workspace => workspace.handleEnableDragMode()),
        handleDisableDragMode: mountWaitSyncVoid('handleDisableDragMode', workspace => workspace.handleDisableDragMode()),
        handleCaptureRegion: mountWaitSyncVoid('handleCaptureRegion', workspace => workspace.handleCaptureRegion()),
        handleCrop: mountWaitSyncVoid('handleCrop', workspace => workspace.handleCrop()),
        handleQuickNote: mountWaitSyncVoid('handleQuickNote', workspace => workspace.handleQuickNote()),
        handleInsertImageFromFile: mountWaitVoid('handleInsertImageFromFile', workspace => workspace.handleInsertImageFromFile()),
        handlePasteImageFromClipboard: mountWaitVoid('handlePasteImageFromClipboard', workspace => workspace.handlePasteImageFromClipboard()),
        handleViewModeSingle: mountWaitSyncVoid('handleViewModeSingle', workspace => workspace.handleViewModeSingle()),
        handleViewModeFacing: mountWaitSyncVoid('handleViewModeFacing', workspace => workspace.handleViewModeFacing()),
        handleViewModeFacingFirstSingle: mountWaitSyncVoid(
            'handleViewModeFacingFirstSingle',
            workspace => workspace.handleViewModeFacingFirstSingle(),
        ),
        handleDeletePages: mountWaitSyncVoid('handleDeletePages', workspace => workspace.handleDeletePages()),
        handleExtractPages: mountWaitSyncVoid('handleExtractPages', workspace => workspace.handleExtractPages()),
        handleRotateCw: mountWaitSyncVoid('handleRotateCw', workspace => workspace.handleRotateCw()),
        handleRotateCcw: mountWaitSyncVoid('handleRotateCcw', workspace => workspace.handleRotateCcw()),
        handleInsertPages: mountWaitSyncVoid('handleInsertPages', workspace => workspace.handleInsertPages()),
        handleConvertToPdf: mountWaitSyncVoid('handleConvertToPdf', workspace => workspace.handleConvertToPdf()),
        captureSplitPayload: () => deps.getMounted()?.captureSplitPayload() ?? Promise.resolve({kind: 'empty'} satisfies TSplitPayload),
        restoreSplitPayload: async (payload: TSplitPayload) => {
            if (!deps.getMounted() && payload.kind === 'empty') {
                return;
            }

            const restorePayload = async () => {
                await deps.withWorkspace('restoreSplitPayload', async (workspace) => {
                    await workspace.restoreSplitPayload(payload);
                    return true;
                });
            };

            if (payload.kind === 'empty') {
                await restorePayload();
                return;
            }

            await deps.enqueueDocumentOpen({
                action: 'restoreSplitPayload',
                target: null,
            }, restorePayload);
        },
        closeAllDropdowns: mountWaitSyncVoid('closeAllDropdowns', workspace => workspace.closeAllDropdowns()),
        waitForDocumentOpenSettled: mountWaitVoid(
            'waitForDocumentOpenSettled',
            workspace => workspace.waitForDocumentOpenSettled(),
        ),
        runAgentAction: async (actionId, input, options) => {
            try {
                return await deps.withLoadedWorkspaceRequired(
                    'runAgentAction',
                    workspace => workspace.runAgentAction(actionId, input, options),
                );
            } catch (error) {
                return {
                    ok: false,
                    actionId,
                    error: getErrorMessage(error),
                };
            }
        },
        readAgentResource: async (uri) => {
            try {
                return await deps.withLoadedWorkspaceRequired(
                    'readAgentResource',
                    workspace => workspace.readAgentResource(uri),
                );
            } catch (error) {
                return {
                    ok: false,
                    uri,
                    error: getErrorMessage(error),
                };
            }
        },
        getAutomationStateSnapshot: () => deps.getMounted()?.getAutomationStateSnapshot() ?? {
            annotationComments: [],
            annotationCommentsStatus: 'loading',
            annotationDirty: false,
            originalPath: null,
            sortedAnnotationNoteWindows: [],
            workingCopyPath: null,
        },
        handleOcrComplete: async (payload) => {
            await deps.withLoadedWorkspace('handleOcrComplete', workspace => workspace.handleOcrComplete?.(payload));
        },
        scrollToPage: (page: number) => {
            void deps.withLoadedWorkspace('scrollToPage', workspace => workspace.scrollToPage?.(page));
        },
        getAllShapes: () => deps.getMounted()?.getAllShapes?.() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => deps.getMounted()?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => deps.getMounted()?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        highlightSelection: async () => (
            await deps.withLoadedWorkspace('highlightSelection', workspace => workspace.highlightSelection?.()) ?? false
        ),
        commentAtPoint: async (pageNumber, pageX, pageY, options) => (
            await deps.withLoadedWorkspace(
                'commentAtPoint',
                workspace => workspace.commentAtPoint?.(pageNumber, pageX, pageY, options),
            ) ?? false
        ),
        getToolbarSnapshot: () => deps.getMounted()?.getToolbarSnapshot() ?? createDefaultWorkspaceToolbarSnapshot(),
    };

    return {
        ...proxy,
        ...deps.overrides,
    };
}
