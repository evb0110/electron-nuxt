import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useDocumentWorkspaceDocumentRecord } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceDocumentRecord';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

describe('useDocumentWorkspaceDocumentRecord', () => {
    it('publishes a pending document record while a cold workspace restores a parent path', async () => {
        const published: IWorkspaceDocumentRecord[] = [];

        useDocumentWorkspaceDocumentRecord({
            pendingDocumentOpen: ref(false),
            pendingDocumentPath: ref('/docs/cold.pdf'),
            openBatchProgress: ref(null),
            hasPdf: ref(false),
            isDjvuMode: ref(false),
            fileName: ref(null),
            originalPath: ref(null),
            isDirty: ref(false),
            djvuSourcePath: ref(null),
            toolbarSnapshot: ref(createDefaultWorkspaceToolbarSnapshot()),
            formatPendingBatchLabel: values => `${values.processed}/${values.total}`,
            publishRecord: record => published.push(record),
        });

        await nextTick();

        expect(published.at(-1)).toMatchObject({
            tab: {
                fileName: 'cold.pdf',
                originalPath: '/docs/cold.pdf',
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                isOpeningDocument: true,
                isDjvuMode: false,
            },
            viewState: {continuousScroll: true},
        });
    });

    it('does not derive pending DjVu view state from fallback toolbar continuous-scroll defaults', async () => {
        const published: IWorkspaceDocumentRecord[] = [];
        const fallbackSnapshot = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            continuousScroll: false,
        };

        useDocumentWorkspaceDocumentRecord({
            pendingDocumentOpen: ref(false),
            pendingDocumentPath: ref('/docs/scan.djvu'),
            openBatchProgress: ref(null),
            hasPdf: ref(false),
            isDjvuMode: ref(false),
            fileName: ref(null),
            originalPath: ref(null),
            isDirty: ref(false),
            djvuSourcePath: ref(null),
            toolbarSnapshot: ref(fallbackSnapshot),
            formatPendingBatchLabel: values => `${values.processed}/${values.total}`,
            publishRecord: record => published.push(record),
        });

        await nextTick();

        expect(published.at(-1)?.toolbarSnapshot).toMatchObject({
            continuousScroll: false,
            isDjvuMode: true,
            isOpeningDocument: true,
        });
        expect(published.at(-1)?.viewState.continuousScroll).toBe(true);
    });
});
