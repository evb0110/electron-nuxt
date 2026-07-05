import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import {
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { cast } from '@tests/helpers/cast';

function createDocumentRevision(token = 'revision-1', documentRef = '/tmp/working.pdf'): IDocumentRevisionInfo {
    return {
        version: 1,
        token,
        documentRef,
        authority: 'browser-document-store',
        contentRevision: token === 'revision-1' ? 1 : 2,
        mintedAt: token === 'revision-1' ? 1 : 2,
    };
}

function createWorkspace() {
    return cast<IWorkspaceExpose>({hasPdf: true});
}

describe('createWorkspaceDocumentSessionCore', () => {
    it('publishes document identity from workspace records', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: '/tmp/original.pdf',
                isDirty: true,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision(),
            toolbarSnapshot: {viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
            }},
        }), 'workspace');

        expect(session.snapshot.value.identity).toMatchObject({
            documentSessionKey: expect.any(String),
            documentInstanceId: expect.any(String),
            documentRef: '/tmp/working.pdf',
            originalPath: '/tmp/original.pdf',
            workingCopyPath: '/tmp/working.pdf',
            fileName: 'Document.pdf',
            isDjvu: false,
            revisionInfo: {token: 'revision-1'},
        });
        expect(session.snapshot.value.dirty).toBe(true);
        expect(session.snapshot.value.closeable).toBe(true);
        expect(session.snapshot.value.phase).toBe('ready');
    });

    it('mints a document session key and preserves it across revision changes', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Document.pdf',
                    originalPath: '/tmp/original.pdf',
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        const initialKey = session.snapshot.value.identity.documentSessionKey;

        expect(initialKey).toBe('document-key-1:/tmp/working.pdf');

        session.applyRevisionInfo(createDocumentRevision('revision-2'));

        expect(session.snapshot.value.identity.documentSessionKey).toBe(initialKey);
    });

    it('remints the document session key when the logical document changes', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: '/tmp/a.pdf',
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        expect(session.snapshot.value.identity.documentSessionKey).toBe('document-key-1:/tmp/a-working.pdf');

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'B.pdf',
                originalPath: '/tmp/b.pdf',
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-2', '/tmp/b-working.pdf'),
        }), 'workspace');

        expect(session.snapshot.value.identity.documentSessionKey).toBe('document-key-2:/tmp/b-working.pdf');
    });

    it('clears the document session key when the session becomes empty', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: '/tmp/a.pdf',
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord(), 'workspace');

        expect(session.snapshot.value.identity.documentSessionKey).toBeNull();
    });

    it('supersedes an active transaction with the latest document operation', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createTransactionId: input => `tx-${input.nextTransactionIndex}`,
        });
        const first = session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/a.pdf',
        });
        const second = session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/b.pdf',
        });

        expect(first.id).toBe('tx-1');
        expect(second.id).toBe('tx-2');
        expect(session.snapshot.value.activeTransaction?.id).toBe(second.id);
        expect(session.snapshot.value.pendingDocumentPath).toBe('/tmp/b.pdf');

        session.finishTransaction(first.id, 'committed');
        expect(session.snapshot.value.activeTransaction?.id).toBe(second.id);

        session.finishTransaction(second.id, 'committed');

        expect(session.snapshot.value.activeTransaction).toBeNull();
    });

    it('fences stale open records after a superseding close wins', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createTransactionId: input => `tx-${input.nextTransactionIndex}`,
        });
        const open = session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/a.pdf',
        });
        const close = session.beginTransaction({
            kind: 'close',
            documentRef: '/tmp/a.pdf',
            persist: false,
        });

        expect(session.snapshot.value.activeTransaction?.id).toBe(close.id);
        expect(session.snapshot.value.pendingClose?.persist).toBe(false);

        session.finishTransaction(close.id, 'committed');
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'A.pdf',
                originalPath: '/tmp/a.pdf',
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            toolbarSnapshot: {viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
            }},
        }), 'workspace');

        expect(session.snapshot.value.identity.documentRef).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');

        session.finishTransaction(open.id, 'committed');
        expect(session.snapshot.value.identity.documentRef).toBeNull();
    });

    it('rejects stale revision command targets after identity changes', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: '/tmp/original.pdf',
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1'),
        }), 'workspace');
        const target = session.createCommandTarget();

        session.applyRevisionInfo(createDocumentRevision('revision-2'));

        expect(session.validateCommandTarget(target)).toEqual({
            ok: false,
            reason: 'document-revision-token-mismatch',
        });
    });

    it('rejects stale command targets when a same-revision reopen mints a new document instance', () => {
        let nextInstanceId = 0;
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createDocumentInstanceId: () => {
                nextInstanceId += 1;
                return `instance-${nextInstanceId}`;
            },
        });
        const record = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: '/tmp/original.pdf',
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1'),
        });
        session.applyWorkspaceRecord(record, 'workspace');
        const initialKey = session.snapshot.value.identity.documentSessionKey;
        const target = session.createCommandTarget();

        const reopen = session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/working.pdf',
        });
        session.applyWorkspaceRecord(record, 'workspace');
        session.finishTransaction(reopen.id, 'committed');

        expect(session.snapshot.value.identity.documentSessionKey).toBe(initialKey);
        expect(session.snapshot.value.identity.documentInstanceId).toBe('instance-2');
        expect(session.snapshot.value.identity.revisionInfo?.token).toBe('revision-1');
        expect(session.validateCommandTarget(target)).toEqual({
            ok: false,
            reason: 'document-instance-id-mismatch',
        });
    });

    it('rejects pending workspace waiters when a target goes stale', async () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            workspaceWaitTimeoutMs: 1000,
        });
        const target = session.createCommandTarget();
        const wait = session.waitForWorkspace(target);

        session.beginTransaction({
            kind: 'open',
            documentRef: '/tmp/next.pdf',
        });

        await expect(wait).resolves.toBeNull();
    });

    it('resolves current workspace waiters when the workspace attaches', async () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const target = session.createCommandTarget();
        const workspace = createWorkspace();
        const wait = session.waitForWorkspace(target);

        session.attachWorkspace(workspace);

        await expect(wait).resolves.toBe(workspace);
        expect(session.snapshot.value.mounted).toBe(true);
    });

    it('does not change command revision for view-only updates or mounting', () => {
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const target = session.createCommandTarget();

        session.attachWorkspace(createWorkspace());
        session.applyViewState({
            zoom: 2,
            effectiveZoom: 2,
            zoomMode: 'custom',
            fitMode: 'width',
            viewMode: 'single',
            showSidebar: true,
            continuousScroll: false,
        });

        expect(session.validateCommandTarget(target)).toEqual({ok: true});
    });
});
