import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TOpenFileResult } from '@contracts/platformApi';

interface IHandleWorkspaceHostOpenFileFromUiOptions {
    mountedWorkspace: IWorkspaceExpose | null;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    withWorkspace: (
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<boolean> | boolean,
    ) => Promise<boolean>;
}

export async function handleWorkspaceHostOpenFileFromUi(
    options: IHandleWorkspaceHostOpenFileFromUiOptions,
) {
    if (options.mountedWorkspace) {
        return options.withWorkspace('handleOpenFileFromUi', workspace => workspace.handleOpenFileFromUi());
    }

    const result = await options.pickFileToOpen();
    if (!result) {
        return false;
    }

    return options.withWorkspace('handleOpenFileWithResultFromUi', workspace => workspace.handleOpenFileWithResult(result));
}
