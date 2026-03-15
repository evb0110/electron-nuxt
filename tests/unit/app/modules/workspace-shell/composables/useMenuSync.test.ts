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
import {
    useMenuSync,
    workspaceHasPdf,
} from '@app/modules/workspace-shell/composables/useMenuSync';

const mocks = vi.hoisted(() => ({
    hasElectronAPI: vi.fn(() => true),
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
}));

vi.mock('@app/utils/platform', () => ({
    hasElectronAPI: () => mocks.hasElectronAPI(),
    getElectronAPI: () => ({documents: {
        setMenuDocumentState: mocks.setMenuDocumentState,
        setMenuTabCount: mocks.setMenuTabCount,
    }}),
}));

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

        expect(mocks.setMenuDocumentState).toHaveBeenCalledWith(false);
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

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(true);
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(2);
    });

    it('resolves hasPdf from boolean, ref, or null workspace', () => {
        expect(workspaceHasPdf(null)).toBe(false);
        expect(workspaceHasPdf({ hasPdf: true })).toBe(true);
        expect(workspaceHasPdf({ hasPdf: ref(false) })).toBe(false);
    });
});
