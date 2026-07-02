import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

describe('useWorkspaceShellState', () => {
    it('treats a document record hint as an active document before the workspace catches up', () => {
        const shellState = useWorkspaceShellState({
            activeDocumentRecord: ref(createWorkspaceDocumentRecord({tab: {
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }})),
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });

        expect(shellState.activeWorkspaceHasDocument.value).toBe(false);
        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.activeTabHasDocumentHint.value).toBe(true);
        expect(shellState.hasDocument.value).toBe(true);
        expect(shellState.tabCount.value).toBe(1);
    });

    it('returns null when there is no active tab', () => {
        const shellState = useWorkspaceShellState({
            activeDocumentRecord: ref(null),
            activeTabId: ref<string | null>(null),
            tabs: ref([]),
        });

        expect(shellState.activeTab.value).toBeNull();
        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.activeTabHasDocumentHint.value).toBe(false);
        expect(shellState.hasDocument.value).toBe(false);
        expect(shellState.tabCount.value).toBe(0);
    });

    it('reads save availability from the active document record toolbar snapshot', () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                canSave: false,
                canRepairSave: true,
            },
        }));
        const shellState = useWorkspaceShellState({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });

        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.activeWorkspaceCanRepairSave.value).toBe(true);

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                canSave: true,
            },
        });

        expect(shellState.activeWorkspaceCanSave.value).toBe(true);
    });
});
