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
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

const mocks = vi.hoisted(() => ({
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
    legacySetMenuDocumentState: vi.fn(async () => {}),
    legacySetMenuTabCount: vi.fn(async () => {}),
}));
const mockPlatformApi = {
    documents: {
        setMenuDocumentState: mocks.legacySetMenuDocumentState,
        setMenuTabCount: mocks.legacySetMenuTabCount,
    },
    documentMenu: {
        setMenuDocumentState: mocks.setMenuDocumentState,
        setMenuTabCount: mocks.setMenuTabCount,
    },
};

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs menu state when workspace or tabs change', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord());
        const tabs = ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenCalledWith({
            hasDocument: false,
            canSave: false,
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
        });
        expect(mocks.setMenuTabCount).toHaveBeenCalledWith(1);

        activeDocumentRecord.value = createWorkspaceDocumentRecord({toolbarSnapshot: { hasPdf: true }});
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
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
        });
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(2);
        expect(mocks.legacySetMenuDocumentState).not.toHaveBeenCalled();
        expect(mocks.legacySetMenuTabCount).not.toHaveBeenCalled();
    });

    it('syncs save availability separately from document presence', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: true,
        }}));

        useMenuSync({
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
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
        });

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                canSave: true,
            },
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
        });
    });

    it('syncs optimize availability independently from repair availability', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: false,
        }}));

        useMenuSync({
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
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: false,
            canPrint: false,
        });

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                canOptimizePdf: true,
            },
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith({
            hasDocument: true,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
        });
    });

    it('resolves hasPdf from boolean, ref, or null workspace', () => {
        expect(workspaceHasPdf(null)).toBe(false);
        expect(workspaceHasPdf({ hasPdf: true })).toBe(true);
        expect(workspaceHasPdf({ hasPdf: ref(false) })).toBe(false);
    });
});
