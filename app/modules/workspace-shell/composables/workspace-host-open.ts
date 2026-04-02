import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TOpenFileResult } from '@contracts/platform-api';

interface IHandleWorkspaceHostOpenFileFromUiOptions {
    mountedWorkspace: IWorkspaceExpose | null;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    withWorkspace: (
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<void> | void,
    ) => Promise<void>;
}

export async function handleWorkspaceHostOpenFileFromUi(
    options: IHandleWorkspaceHostOpenFileFromUiOptions,
) {
    if (options.mountedWorkspace) {
        await options.withWorkspace('handleOpenFileFromUi', async (workspace) => {
            await workspace.handleOpenFileFromUi();
        });
        return;
    }

    const result = await options.pickFileToOpen();
    if (!result) {
        return;
    }

    await options.withWorkspace('handleOpenFileWithResultFromUi', async (workspace) => {
        await workspace.handleOpenFileWithResult(result);
    });
}
