import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

interface IInvokeTargetedWorkspaceCommandOptions<T> {
    session: IWorkspaceDocumentSessionController;
    target: TWorkspaceCommandTarget;
    unavailableResult: T;
    staleResult?: T;
    timeoutMs?: number;
    run: (workspace: IWorkspaceExpose) => Promise<T> | T;
}

export async function invokeTargetedWorkspaceCommand<T>(
    options: IInvokeTargetedWorkspaceCommandOptions<T>,
) {
    const staleResult = options.staleResult ?? options.unavailableResult;
    if (!options.session.validateCommandTarget(options.target).ok) {
        return staleResult;
    }

    const workspace = await options.session.waitForWorkspace(options.target, options.timeoutMs);
    if (!options.session.validateCommandTarget(options.target).ok) {
        return staleResult;
    }

    if (!workspace) {
        return options.unavailableResult;
    }

    return options.run(workspace);
}
