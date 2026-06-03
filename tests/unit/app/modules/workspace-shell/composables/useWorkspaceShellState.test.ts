import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';

describe('useWorkspaceShellState', () => {
    it('treats a mounted document hint as an active document before the workspace catches up', () => {
        const shellState = useWorkspaceShellState({
            activeWorkspace: ref({ hasPdf: false }),
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
            activeWorkspace: ref(null),
            activeTabId: ref<string | null>(null),
            tabs: ref([]),
        });

        expect(shellState.activeTab.value).toBeNull();
        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.activeTabHasDocumentHint.value).toBe(false);
        expect(shellState.hasDocument.value).toBe(false);
        expect(shellState.tabCount.value).toBe(0);
    });

    it('reads save availability from the active workspace toolbar snapshot', () => {
        const canSave = ref(false);
        const shellState = useWorkspaceShellState({
            activeWorkspace: ref({
                hasPdf: true,
                getToolbarSnapshot: () => ({ canSave: canSave.value }),
            }),
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

        canSave.value = true;

        expect(shellState.activeWorkspaceCanSave.value).toBe(true);
    });
});
