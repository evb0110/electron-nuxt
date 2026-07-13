import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldResetDocumentOpenSurfaceForEmptySession } from '@app/modules/workspace-shell/host/shouldResetDocumentOpenSurfaceForEmptySession';
import type { IWorkspaceDocumentSessionSnapshot } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function createSession(
    overrides: Partial<IWorkspaceDocumentSessionSnapshot> = {},
): IWorkspaceDocumentSessionSnapshot {
    return {
        tabId: 'tab-1',
        sessionId: 'session-1',
        sessionRevision: 3,
        phase: 'empty',
        identity: {
            documentSessionKey: null,
            documentInstanceId: null,
            documentRef: null,
            originalPath: null,
            workingCopyPath: null,
            fileName: null,
            isDjvu: false,
            revisionInfo: null,
        },
        activeTransaction: null,
        mounted: true,
        toolbarSnapshot: {} as IWorkspaceDocumentSessionSnapshot['toolbarSnapshot'],
        viewState: {} as IWorkspaceDocumentSessionSnapshot['viewState'],
        dirty: false,
        closeable: false,
        pendingDocumentPath: null,
        pendingClose: null,
        ...overrides,
    };
}

function createSurface(phase: IDocumentOpenSurfaceSnapshot['phase']): IDocumentOpenSurfaceSnapshot {
    return {phase} as IDocumentOpenSurfaceSnapshot;
}

describe('shouldResetDocumentOpenSurfaceForEmptySession', () => {
    it('retires the closed document generation once the session owns no document', () => {
        expect(shouldResetDocumentOpenSurfaceForEmptySession(
            createSession(),
            createSurface('ready'),
        )).toBe(true);
    });

    it('does not reset an active close/open transaction or a non-empty identity', () => {
        const activeTransaction: NonNullable<IWorkspaceDocumentSessionSnapshot['activeTransaction']> = {
            id: 'close-1',
            tabId: 'tab-1',
            kind: 'close',
            documentRef: null,
            startedAt: 1,
        };
        expect(shouldResetDocumentOpenSurfaceForEmptySession(
            createSession({activeTransaction}),
            createSurface('ready'),
        )).toBe(false);
        expect(shouldResetDocumentOpenSurfaceForEmptySession(
            createSession({phase: 'ready'}),
            createSurface('ready'),
        )).toBe(false);
    });

    it('does not repeatedly reset an already idle empty surface', () => {
        expect(shouldResetDocumentOpenSurfaceForEmptySession(
            createSession(),
            createSurface('idle'),
        )).toBe(false);
    });
});
