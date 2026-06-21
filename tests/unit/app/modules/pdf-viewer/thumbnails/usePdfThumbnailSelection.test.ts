import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
} from 'vue';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';

function createSelectionHarness() {
    const totalPages = ref(5);
    const selectedPages = ref([
        2,
        4,
    ]);
    const onSelectedPagesChange = vi.fn((pages: number[]) => {
        selectedPages.value = pages;
    });
    const selection = usePdfThumbnailSelection({
        consumeClickSkip: () => false,
        currentPage: computed(() => 2),
        isDragging: ref(false),
        isExternalDragOver: ref(false),
        markUserInteraction: vi.fn(),
        onContextMenu: vi.fn(),
        onGoToPage: vi.fn(),
        onSelectedPagesChange,
        scrollPageIntoKeyboardView: vi.fn(),
        selectedPages: computed(() => selectedPages.value),
        totalPages: computed(() => totalPages.value),
    });
    return {
        onSelectedPagesChange,
        selectedPages,
        selection,
        totalPages,
    };
}

describe('usePdfThumbnailSelection', () => {
    it('renormalizes selected pages when total pages shrinks', async () => {
        const {
            onSelectedPagesChange,
            selectedPages,
            totalPages,
        } = createSelectionHarness();
        onSelectedPagesChange.mockClear();

        totalPages.value = 3;
        await nextTick();

        expect(onSelectedPagesChange).toHaveBeenCalledWith([2]);
        expect(selectedPages.value).toEqual([2]);
    });
});
