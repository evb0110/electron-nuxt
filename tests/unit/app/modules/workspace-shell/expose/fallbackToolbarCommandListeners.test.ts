import {ref} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createFallbackToolbarCommandListeners} from '@app/modules/workspace-shell/expose/createFallbackToolbarCommandListeners';
import type {IWorkspaceExpose} from '@app/types/workspaceExpose';
import {
    createWorkspaceExposeCommandHandlers,
    createWorkspaceExposeFromCommandHandlers,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import type * as WorkspaceExposeDescriptors from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

const mocks = vi.hoisted(() => ({
    guardAsync: vi.fn(),
    invoke: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('@app/utils/asyncGuard', () => ({guardAsync: mocks.guardAsync}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {error: mocks.logError}}));
vi.mock('@app/modules/workspace-shell/expose/workspaceExposeDescriptors', async importOriginal => {
    const original = await importOriginal<typeof WorkspaceExposeDescriptors>();
    return {
        ...original,
        invokeWorkspaceExposeCommand: mocks.invoke,
        workspaceExposeToolbarCommandDescriptors: [{
            name: 'handleSave',
            toolbar: {eventName: 'save'},
        }],
        WorkspaceExposeCommandUnavailableError: class WorkspaceExposeCommandUnavailableError extends Error {},
    };
});

describe('fallback toolbar command listeners', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports a missing workspace and guards asynchronous workspace commands', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(null);
        const bindings = createFallbackToolbarCommandListeners(activeWorkspace);

        bindings.listeners.save?.();
        expect(mocks.logError).toHaveBeenCalledWith(
            'shell',
            'Fallback workspace command unavailable',
            expect.objectContaining({error: expect.any(Error)}),
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        expect(mocks.invoke).not.toHaveBeenCalled();

        const pending = Promise.resolve(true);
        const workspace = createWorkspaceExposeFromCommandHandlers(
            true,
            createWorkspaceExposeCommandHandlers(() => vi.fn()),
        );
        activeWorkspace.value = workspace;
        mocks.invoke.mockReturnValue(pending);

        bindings.listeners.save?.('from-toolbar');

        expect(mocks.invoke).toHaveBeenCalledWith(workspace, 'handleSave', ['from-toolbar']);
        expect(mocks.guardAsync).toHaveBeenCalledWith(pending, {
            category: 'user-visible-operation',
            scope: 'shell',
            message: 'Fallback workspace command failed: handleSave',
        });
    });
});
