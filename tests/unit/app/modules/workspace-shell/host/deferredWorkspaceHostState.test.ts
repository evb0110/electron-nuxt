import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import {
    createWorkspaceRestoreAttemptState,
    tryClaimWorkspaceRestoreAttempt,
    workspaceHasOpenedDocument,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { cast } from '@tests/helpers/cast';

function createColdDocumentSession(tabId: string, path: string) {
    return createWorkspaceDocumentSessionCore({
        tabId,
        sessionId: `session-${tabId}`,
        initialRecord: createWorkspaceDocumentRecord({
            tab: {
                fileName: path.split('/').at(-1) ?? path,
                originalPath: path,
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                currentPage: 3,
                totalPages: 8,
            },
        }),
    });
}

function createEmptyMountedWorkspace() {
    return cast<IWorkspaceExpose>({getToolbarSnapshot: vi.fn(() => createDefaultWorkspaceToolbarSnapshot())});
}

describe('deferredWorkspaceHostState', () => {
    it('claims exactly one cold restore when reactivating a tab under aggressive lifecycle', () => {
        const firstSession = createColdDocumentSession('tab-1', '/tmp/first.pdf');
        const secondSession = createColdDocumentSession('tab-2', '/tmp/second.pdf');
        const restoreAttempts = createWorkspaceRestoreAttemptState();
        const restoredPaths: string[] = [];

        expect(workspaceHasOpenedDocument(null, secondSession.snapshot.value)).toBe(true);
        expect(workspaceHasOpenedDocument(null, firstSession.snapshot.value)).toBe(true);

        const mountedWorkspace = createEmptyMountedWorkspace();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (
                !workspaceHasOpenedDocument(mountedWorkspace, firstSession.snapshot.value)
                && tryClaimWorkspaceRestoreAttempt(
                    restoreAttempts,
                    firstSession.snapshot.value,
                    '/tmp/first.pdf',
                )
            ) {
                restoredPaths.push('/tmp/first.pdf');
            }
        }

        expect(restoredPaths).toEqual(['/tmp/first.pdf']);
    });
});
