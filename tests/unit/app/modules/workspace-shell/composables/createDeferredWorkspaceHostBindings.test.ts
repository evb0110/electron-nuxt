import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shallowRef } from 'vue';
import { createDeferredWorkspaceHostBindings } from '@app/modules/workspace-shell/composables/createDeferredWorkspaceHostBindings';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { cast } from '@tests/helpers/cast';

function createWorkspace() {
    let continuousScroll = true;
    return cast<IWorkspaceExpose>({
        getToolbarSnapshot: () => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            continuousScroll,
        }),
        handleToggleContinuousScroll: () => {
            continuousScroll = !continuousScroll;
        },
    });
}

describe('createDeferredWorkspaceHostBindings', () => {
    it('keeps the current handle when a replaced workspace releases, so mode changes reach its snapshot', () => {
        const attachWorkspace = vi.fn();
        const detachWorkspace = vi.fn();
        const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
        const bindings = createDeferredWorkspaceHostBindings({
            emit: vi.fn(),
            activeDocumentSession: cast({value: {
                attachWorkspace,
                detachWorkspace,
            }}),
            mountedWorkspace,
        });
        const replacedWorkspace = createWorkspace();
        const currentWorkspace = createWorkspace();

        bindings.handleWorkspaceExposeReady(replacedWorkspace);
        bindings.handleWorkspaceExposeReady(currentWorkspace);
        bindings.handleWorkspaceExposeReleased(replacedWorkspace);
        currentWorkspace.handleToggleContinuousScroll();

        expect(mountedWorkspace.value).toBe(currentWorkspace);
        expect(mountedWorkspace.value?.getToolbarSnapshot().continuousScroll).toBe(false);
        expect(detachWorkspace).not.toHaveBeenCalled();
    });
});
