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
} from '@app/composables/page/useMenuSync';

const mocks = vi.hoisted(() => ({
    hasElectronAPI: vi.fn(() => true),
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
}));

vi.mock('@app/utils/electron', () => ({
    hasElectronAPI: () => mocks.hasElectronAPI(),
    getElectronAPI: () => ({
        setMenuDocumentState: mocks.setMenuDocumentState,
        setMenuTabCount: mocks.setMenuTabCount,
    }),
}));

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs menu document state and tab count with dedupe', async () => {
        const tabs = ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);
        const hasPdfRef = ref(false);
        const activeWorkspace = ref({ hasPdf: hasPdfRef });

        useMenuSync({
            activeWorkspace,
            tabs,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenCalledWith(false);
        expect(mocks.setMenuTabCount).toHaveBeenCalledWith(1);

        await nextTick();
        expect(mocks.setMenuDocumentState).toHaveBeenCalledTimes(1);
        expect(mocks.setMenuTabCount).toHaveBeenCalledTimes(1);

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

    it('handles both boolean and ref-based workspace hasPdf values', () => {
        expect(workspaceHasPdf(null)).toBe(false);
        expect(workspaceHasPdf({ hasPdf: true })).toBe(true);
        expect(workspaceHasPdf({ hasPdf: ref(false) })).toBe(false);
    });
});
