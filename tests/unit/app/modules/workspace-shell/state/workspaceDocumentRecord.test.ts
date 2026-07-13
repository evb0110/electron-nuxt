import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

describe('workspace document record opening view state', () => {
    it('uses continuous scrolling for a new empty tab open', () => {
        const record = createPendingWorkspaceDocumentRecord({
            fileName: 'scan.pdf',
            originalPath: '/docs/scan.pdf',
        });

        expect(record.toolbarSnapshot.continuousScroll).toBe(true);
        expect(record.viewState.continuousScroll).toBe(true);
    });

    it('preserves an existing tab view state while replacing its document', () => {
        const previous = createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            continuousScroll: false,
        }});
        const pending = createPendingWorkspaceDocumentRecord({
            fileName: 'replacement.pdf',
            originalPath: '/docs/replacement.pdf',
        }, previous.toolbarSnapshot, previous.viewState);

        expect(pending.toolbarSnapshot.continuousScroll).toBe(false);
        expect(pending.viewState.continuousScroll).toBe(false);
    });
});
