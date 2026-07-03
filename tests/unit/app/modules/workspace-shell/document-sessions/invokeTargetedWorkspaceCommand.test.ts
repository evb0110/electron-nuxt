import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { invokeTargetedWorkspaceCommand } from '@app/modules/workspace-shell/document-sessions/invokeTargetedWorkspaceCommand';
import { cast } from '@tests/helpers/cast';

function createWorkspace() {
    return cast<IWorkspaceExpose>({hasPdf: true});
}

describe('invokeTargetedWorkspaceCommand', () => {
    it('invokes the workspace when the target remains current', async () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const workspace = createWorkspace();
        const run = vi.fn(() => true);
        const target = session.createCommandTarget();

        session.attachWorkspace(workspace);

        await expect(invokeTargetedWorkspaceCommand({
            session,
            target,
            unavailableResult: false,
            run,
        })).resolves.toBe(true);
        expect(run).toHaveBeenCalledWith(workspace);
    });

    it('returns the stale result before waiting when the target is stale', async () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const run = vi.fn(() => true);
        const target = session.createCommandTarget();

        session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/next.pdf',
        });

        await expect(invokeTargetedWorkspaceCommand({
            session,
            target,
            unavailableResult: 'unavailable',
            staleResult: 'stale',
            run: () => 'ran',
        })).resolves.toBe('stale');
        expect(run).not.toHaveBeenCalled();
    });

    it('returns the unavailable result when no workspace attaches', async () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            workspaceWaitTimeoutMs: 0,
        });

        await expect(invokeTargetedWorkspaceCommand({
            session,
            target: session.createCommandTarget(),
            unavailableResult: false,
            run: () => true,
        })).resolves.toBe(false);
    });
});
