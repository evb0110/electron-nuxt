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
import {
    createWorkspaceExposeCommandHandlers,
    createWorkspaceExposeCommandRunner,
    createWorkspaceExposeFromCommandHandlers,
    invokeWorkspaceExposeCommand,
    WorkspaceExposeCommandUnavailableError,
    type IWorkspaceExposeCommandDescriptor,
    type TWorkspaceExposeCommandHandlerMap,
    type TWorkspaceExposeCommandRunner,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

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
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<boolean> | boolean,
    ) {
        return async (...args: unknown[]) => await deps.withLoadedWorkspace(action, workspace => run(workspace, args)) === true;
    }

    function mountWaitVoid(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<void> | void,
    ) {
        return async (...args: unknown[]) => {
            await deps.withLoadedWorkspace(action, workspace => run(workspace, args));
        };
    }

    function mountWaitSyncVoid(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => void,
    ) {
        return (...args: unknown[]) => {
            void deps.withLoadedWorkspace(action, workspace => run(workspace, args));
        };
    }

    async function directBoolean(
        action: TWorkspaceExposeMethod,
        run: (workspace: IWorkspaceExpose, args: readonly unknown[]) => Promise<boolean> | boolean,
        args: readonly unknown[] = [],
    ) {
        const workspace = deps.getMounted();
        if (!workspace) {
            deps.log(action, new WorkspaceExposeCommandUnavailableError(action));
            return false;
        }
        try {
            return await run(workspace, args);
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

    function createDeferredStrategyHandler(
        descriptor: IWorkspaceExposeCommandDescriptor,
    ): TWorkspaceExposeCommandRunner | null {
        const { name } = descriptor;
        if (descriptor.deferred === 'mountWaitBoolean') {
            return mountWaitBoolean(name, async (workspace, args) => (
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, args)) === true
            ));
        }

        if (descriptor.deferred === 'mountWaitVoid') {
            return mountWaitVoid(name, async (workspace, args) => {
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, args));
            });
        }

        if (descriptor.deferred === 'mountWaitSyncVoid') {
            return mountWaitSyncVoid(name, (workspace, args) => {
                void invokeWorkspaceExposeCommand(workspace, name, args);
            });
        }

        if (descriptor.deferred === 'directBoolean') {
            return async (...args: unknown[]) => directBoolean(name, async (workspace, commandArgs) => (
                await Promise.resolve(invokeWorkspaceExposeCommand(workspace, name, commandArgs)) === true
            ), args);
        }

        return null;
    }

    const customHandlers: Partial<TWorkspaceExposeCommandHandlerMap> = {
        handleOpenFileFromUi: () => Promise.resolve(false),
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
            await deps.withLoadedWorkspace(
                'handleOcrComplete',
                workspace => invokeWorkspaceExposeCommand(workspace, 'handleOcrComplete', [payload]),
            );
        },
        scrollToPage: (page: number) => {
            void deps.withLoadedWorkspace(
                'scrollToPage',
                workspace => invokeWorkspaceExposeCommand(workspace, 'scrollToPage', [page]),
            );
        },
        getAllShapes: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getAllShapes') : [];
        },
        getDeletedEmbeddedShapeAnnotationIds: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getDeletedEmbeddedShapeAnnotationIds') : [];
        },
        getDeletedEmbeddedShapeStableKeys: () => {
            const workspace = deps.getMounted();
            return workspace ? invokeWorkspaceExposeCommand(workspace, 'getDeletedEmbeddedShapeStableKeys') : [];
        },
        highlightSelection: async () => {
            const result = await deps.withLoadedWorkspace(
                'highlightSelection',
                workspace => invokeWorkspaceExposeCommand(workspace, 'highlightSelection'),
            );
            return result === true;
        },
        commentAtPoint: async (pageNumber, pageX, pageY, options) => {
            const result = await deps.withLoadedWorkspace(
                'commentAtPoint',
                workspace => invokeWorkspaceExposeCommand(workspace, 'commentAtPoint', [
                    pageNumber,
                    pageX,
                    pageY,
                    options,
                ]),
            );
            return result === true;
        },
        getToolbarSnapshot: () => deps.getMounted()?.getToolbarSnapshot() ?? createDefaultWorkspaceToolbarSnapshot(),
    };

    const commandHandlers = createWorkspaceExposeCommandHandlers((descriptor) => {
        if (descriptor.deferred === 'custom') {
            const handler = customHandlers[descriptor.name];
            return handler ? createWorkspaceExposeCommandRunner(handler) : null;
        }

        return createDeferredStrategyHandler(descriptor);
    });

    return createWorkspaceExposeFromCommandHandlers(false, commandHandlers, deps.overrides);
}
