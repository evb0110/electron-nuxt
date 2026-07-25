import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import {
    createWorkspaceRestoreAttemptState,
    finishWorkspaceRestoreAttempt,
    tryClaimWorkspaceRestoreAttempt,
    workspaceHasDocumentOrOpenError,
    workspaceHasOpenedDocument,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { cast } from '@tests/helpers/cast';

function createColdDocumentSession(tabId: string, path: string) {
    return createWorkspaceDocumentController({
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

function createMountedWorkspace(
    toolbarSnapshot: ReturnType<typeof createDefaultWorkspaceToolbarSnapshot>,
) {
    return cast<IWorkspaceExpose>({getToolbarSnapshot: vi.fn(() => toolbarSnapshot)});
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

    it('restores a cold PDF once when pending capabilities have no committed source', () => {
        const session = createColdDocumentSession('tab-1', '/tmp/pending.pdf');
        const restoreAttempts = createWorkspaceRestoreAttemptState();
        const restoredPaths: string[] = [];
        const pendingWorkspace = createMountedWorkspace({
            ...createDefaultWorkspaceToolbarSnapshot(),
            isOpeningDocument: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
            },
        });

        expect(workspaceHasOpenedDocument(pendingWorkspace, session.snapshot.value)).toBe(false);
        expect(workspaceHasDocumentOrOpenError(pendingWorkspace, session.snapshot.value)).toBe(false);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (
                !workspaceHasOpenedDocument(pendingWorkspace, session.snapshot.value)
                && tryClaimWorkspaceRestoreAttempt(
                    restoreAttempts,
                    session.snapshot.value,
                    '/tmp/pending.pdf',
                )
            ) {
                restoredPaths.push('/tmp/pending.pdf');
            }
        }

        expect(restoredPaths).toEqual(['/tmp/pending.pdf']);
    });

    it('recognizes a committed PDF source with document capabilities as opened', () => {
        const workspace = createMountedWorkspace({
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
            },
        });

        expect(workspaceHasOpenedDocument(workspace)).toBe(true);
        expect(workspaceHasDocumentOrOpenError(workspace)).toBe(true);
    });

    it('recognizes a committed DjVu source with document capabilities as opened', () => {
        const workspace = createMountedWorkspace({
            ...createDefaultWorkspaceToolbarSnapshot(),
            isDjvuMode: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
            },
        });

        expect(workspaceHasOpenedDocument(workspace)).toBe(true);
        expect(workspaceHasDocumentOrOpenError(workspace)).toBe(true);
    });

    it('allows a failed cold restore claim to retry and keeps completed restores one-shot', () => {
        const session = createColdDocumentSession('tab-1', '/tmp/first.pdf');
        const restoreAttempts = createWorkspaceRestoreAttemptState();

        expect(tryClaimWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
        )).toBe(true);
        expect(tryClaimWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
        )).toBe(false);

        finishWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
            false,
        );
        expect(tryClaimWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
        )).toBe(true);

        finishWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
            true,
        );
        expect(tryClaimWorkspaceRestoreAttempt(
            restoreAttempts,
            session.snapshot.value,
            '/tmp/first.pdf',
        )).toBe(false);
    });

    it('does not treat stale seeded identity as opened after the session enters an error phase', () => {
        const session = createColdDocumentSession('tab-1', '/tmp/failed.pdf');
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'failed.pdf',
                originalPath: '/tmp/failed.pdf',
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: { hasOpenError: true },
        }), 'host');

        expect(session.snapshot.value.phase).toBe('error');
        expect(workspaceHasOpenedDocument(null, session.snapshot.value)).toBe(false);
    });
});
