import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';

const mocks = vi.hoisted(() => ({
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
}));
const mockPlatformApi = { documents: {
    setMenuDocumentState: mocks.setMenuDocumentState,
    setMenuTabCount: mocks.setMenuTabCount,
} };

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs menu state when workspace or tabs change', async () => {
        const hasPdfRef = ref(false);
        const tabs = ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);

        useMenuSync({
            activeWorkspace: ref({ hasPdf: hasPdfRef }),
            activeTabId: ref<string | null>('tab-1'),
            tabs,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenCalledWith({
            hasDocument: false,
            canSave: false,
            canRepairSave: false,
        });
        expect(mocks.setMenuTabCount).toHaveBeenCalledWith(1);

        hasPdfRef.value = true;
        tabs.value.push({
            id: 'tab-2',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
        });
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(2);
    });

    it('syncs save availability separately from document presence', async () => {
        const canSaveRef = ref(false);

        useMenuSync({
            activeWorkspace: ref({
                hasPdf: true,
                getToolbarSnapshot: () => ({ canSave: canSaveRef.value }),
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
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
        });

        canSaveRef.value = true;
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: true,
            canRepairSave: true,
        });
    });

    it('resolves hasPdf from boolean, ref, or null workspace', () => {
        expect(workspaceHasPdf(null)).toBe(false);
        expect(workspaceHasPdf({ hasPdf: true })).toBe(true);
        expect(workspaceHasPdf({ hasPdf: ref(false) })).toBe(false);
    });
});
