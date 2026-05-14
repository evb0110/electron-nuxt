import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { handleWorkspaceHostOpenFileFromUi } from '@app/modules/workspace-shell/composables/workspaceHostOpen';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TOpenFileResult } from '@contracts/platformApi';

function cast<T>(value: unknown): T {
    return value as T;
}

function createOpenResult(): TOpenFileResult {
    return {
        kind: 'pdf',
        originalPath: '/docs/source.pdf',
        workingPath: '/docs/source-working.pdf',
    };
}

function createWorkspace() {
    return cast<IWorkspaceExpose>({
        handleOpenFileFromUi: vi.fn(async () => true),
        handleOpenFileWithResult: vi.fn(async (_result: TOpenFileResult) => true),
    });
}

describe('handleWorkspaceHostOpenFileFromUi', () => {
    it('delegates directly to an already mounted workspace', async () => {
        const workspace = createWorkspace();
        const pickFileToOpen = vi.fn(async () => createOpenResult());
        const withWorkspace = vi.fn(async (_action, run) => {
            return run(workspace);
        });

        await expect(handleWorkspaceHostOpenFileFromUi({
            mountedWorkspace: workspace,
            pickFileToOpen,
            withWorkspace,
        })).resolves.toBe(true);

        expect(pickFileToOpen).not.toHaveBeenCalled();
        expect(withWorkspace).toHaveBeenCalledWith(
            'handleOpenFileFromUi',
            expect.any(Function),
        );
        expect(workspace.handleOpenFileFromUi).toHaveBeenCalledOnce();
        expect(workspace.handleOpenFileWithResult).not.toHaveBeenCalled();
    });

    it('picks a file before mounting an empty placeholder workspace', async () => {
        const workspace = createWorkspace();
        const result = createOpenResult();
        const callOrder: string[] = [];
        const pickFileToOpen = vi.fn(async () => {
            callOrder.push('pick');
            return result;
        });
        const withWorkspace = vi.fn(async (_action, run) => {
            callOrder.push('mount');
            return run(workspace);
        });

        await expect(handleWorkspaceHostOpenFileFromUi({
            mountedWorkspace: null,
            pickFileToOpen,
            withWorkspace,
        })).resolves.toBe(true);

        expect(callOrder).toEqual([
            'pick',
            'mount',
        ]);
        expect(withWorkspace).toHaveBeenCalledWith(
            'handleOpenFileWithResultFromUi',
            expect.any(Function),
        );
        expect(workspace.handleOpenFileWithResult).toHaveBeenCalledWith(result);
        expect(workspace.handleOpenFileFromUi).not.toHaveBeenCalled();
    });

    it('does not mount a workspace when the picker is cancelled', async () => {
        const pickFileToOpen = vi.fn(async () => null);
        const withWorkspace = vi.fn(async () => false);

        await expect(handleWorkspaceHostOpenFileFromUi({
            mountedWorkspace: null,
            pickFileToOpen,
            withWorkspace,
        })).resolves.toBe(false);

        expect(pickFileToOpen).toHaveBeenCalledOnce();
        expect(withWorkspace).not.toHaveBeenCalled();
    });
});
