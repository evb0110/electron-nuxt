import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useWorkspaceDocumentRecords } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentRecords';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { ITab } from '@app/types/tabs';

function createTab(overrides: Partial<ITab> = {}): ITab {
    return {
        id: 'tab-1',
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
        ...overrides,
    };
}

describe('useWorkspaceDocumentRecords', () => {
    it('seeds document-hint tabs as pending records before the workspace mounts', () => {
        const tabs = ref([createTab({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
        })]);
        const records = useWorkspaceDocumentRecords({
            activeTabId: ref('tab-1'),
            tabs,
        });

        expect(records.activeDocumentRecord.value?.tab).toMatchObject({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
        });
        expect(records.activeDocumentRecord.value?.toolbarSnapshot).toMatchObject({
            hasPdf: true,
            isOpeningDocument: true,
        });
    });

    it('lets the live workspace replace a pending seed with the authoritative record', () => {
        const tabs = ref([createTab({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
        })]);
        const records = useWorkspaceDocumentRecords({
            activeTabId: ref('tab-1'),
            tabs,
        });

        records.setWorkspaceDocumentRecord('tab-1', createWorkspaceDocumentRecord({
            tab: {
                fileName: 'paper.pdf',
                originalPath: '/docs/paper.pdf',
                isDirty: true,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                canSave: true,
                currentPage: 7,
                totalPages: 10,
            },
        }));

        expect(records.activeDocumentRecord.value?.tab.isDirty).toBe(true);
        expect(records.activeDocumentRecord.value?.toolbarSnapshot).toMatchObject({
            isOpeningDocument: false,
            canSave: true,
            currentPage: 7,
            totalPages: 10,
        });
    });

    it('seeds pending records for shell-owned tab updates', () => {
        const tabs = ref([createTab()]);
        const records = useWorkspaceDocumentRecords({
            activeTabId: ref('tab-1'),
            tabs,
        });

        records.seedTabDocumentRecord('tab-1', {
            fileName: 'scan.djvu',
            originalPath: '/docs/scan.djvu',
            isDjvu: true,
        });

        expect(records.getDocumentRecord('tab-1')?.toolbarSnapshot).toMatchObject({
            hasPdf: true,
            isDjvuMode: true,
            isOpeningDocument: true,
        });
        expect(records.getDocumentRecord('tab-1')?.viewState.continuousScroll).toBe(true);
    });

    it('prunes records when tabs are removed', async () => {
        const tabs = ref([createTab()]);
        const records = useWorkspaceDocumentRecords({
            activeTabId: ref('tab-1'),
            tabs,
        });

        expect(records.getDocumentRecord('tab-1')).not.toBeNull();

        tabs.value = [];
        await nextTick();

        expect(records.getDocumentRecord('tab-1')).toBeNull();
        expect(records.documentRecordsByTabId.value).toEqual({});
    });
});
