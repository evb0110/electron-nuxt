import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createDeferredWorkspaceExposeProxy } from '@app/modules/workspace-shell/expose/createDeferredWorkspaceExposeProxy';
import { workspaceExposeRequiredMethodNames } from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { cast } from '@tests/helpers/cast';

function createWorkspace(overrides: Partial<IWorkspaceExpose> = {}) {
    const workspace: Record<string, unknown> = {hasPdf: true};
    for (const method of workspaceExposeRequiredMethodNames) {
        workspace[method] = vi.fn(async () => true);
    }
    return cast<IWorkspaceExpose>({
        ...workspace,
        ...overrides,
    });
}

function createDeps(workspace: IWorkspaceExpose | null) {
    const log = vi.fn();
    const enqueueDocumentOpen = vi.fn(async (_intent, run: () => Promise<unknown>) => run());
    return cast<Parameters<typeof createDeferredWorkspaceExposeProxy>[0]>({
        enqueueDocumentOpen,
        getMounted: () => workspace,
        log,
        withLoadedWorkspace: vi.fn(async (_action, run) => (
            workspace ? run(workspace) : null
        )),
        withLoadedWorkspaceRequired: vi.fn(async (_action, run) => {
            if (!workspace) {
                throw new Error('Workspace is not available.');
            }
            return run(workspace);
        }),
        withWorkspace: vi.fn(async (_action, run) => (
            workspace ? await run(workspace) !== false : false
        )),
    });
}

describe('createDeferredWorkspaceExposeProxy', () => {
    it('forwards mount-wait methods and returns their result', async () => {
        const workspace = createWorkspace({handleSave: vi.fn(async () => true)});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleSave()).resolves.toBe(true);

        expect(deps.withLoadedWorkspace).toHaveBeenCalledWith('handleSave', expect.any(Function));
        expect(workspace.handleSave).toHaveBeenCalledOnce();
    });

    it('returns safe defaults when mount-wait methods have no workspace', async () => {
        const deps = createDeps(null);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleSave()).resolves.toBe(false);
    });

    it('routes assistant actions through the mount-wait workspace path', async () => {
        const runAgentAction = vi.fn(async () => ({
            ok: true,
            actionId: 'file.save',
        }));
        const workspace = createWorkspace({runAgentAction});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('file.save', {tabId: 'tab-1'})).resolves.toEqual({
            ok: true,
            actionId: 'file.save',
        });

        expect(deps.withLoadedWorkspaceRequired).toHaveBeenCalledWith('runAgentAction', expect.any(Function));
        expect(runAgentAction).toHaveBeenCalledWith('file.save', {tabId: 'tab-1'}, undefined);
    });

    it('returns an MCP-safe assistant action error when no workspace can mount', async () => {
        const deps = createDeps(null);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('file.save', {tabId: 'tab-1'})).resolves.toEqual({
            ok: false,
            actionId: 'file.save',
            error: 'Workspace is not available.',
        });
    });

    it('returns the real assistant action error when the inner workspace rejects', async () => {
        const workspace = createWorkspace({runAgentAction: vi.fn(async () => {
            throw new Error('Bookmark plan is invalid.');
        })});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.runAgentAction('bookmarks.apply_plan', {})).resolves.toEqual({
            ok: false,
            actionId: 'bookmarks.apply_plan',
            error: 'Bookmark plan is invalid.',
        });
    });

    it('queues document-open methods and invokes the inner workspace call', async () => {
        const workspace = createWorkspace({handleOpenFileWithResult: vi.fn(async () => true)});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleOpenFileWithResult(cast({
            kind: 'pdf',
            path: '/tmp/a.pdf',
        }))).resolves.toBe(true);

        expect(deps.enqueueDocumentOpen).toHaveBeenCalledWith(
            expect.objectContaining({action: 'handleOpenFileWithResult'}),
            expect.any(Function),
        );
        expect(workspace.handleOpenFileWithResult).toHaveBeenCalledOnce();
    });

    it('logs and returns false for direct method failures', async () => {
        const error = new Error('boom');
        const handleCombineImages = vi.fn(async () => {
            throw error;
        });
        const workspace = createWorkspace({handleCombineImages});
        const deps = createDeps(workspace);
        const proxy = createDeferredWorkspaceExposeProxy(deps);

        await expect(proxy.handleCombineImages()).resolves.toBe(false);

        expect(deps.log).toHaveBeenCalledWith('handleCombineImages', error);
    });

});
