import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import { cast } from '@tests/helpers/cast';

vi.mock('vue', async () => ({
    ...await vi.importActual('vue'),
    onUnmounted: vi.fn(),
}));

function createDropEvent(paths: string[]) {
    const files = paths.map((path, index) => cast<File>({
        name: `file-${index}`,
        path,
    }));

    return cast<DragEvent>({
        dataTransfer: { files },
        preventDefault: vi.fn(),
    });
}

describe('usePageDragDrop', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('extracts external dropped paths through the split picker capability', () => {
        const legacyGetPathsForFiles = vi.fn(() => {
            throw new Error('legacy page drop path extraction should not be used');
        });
        const pickerGetPathsForFiles = vi.fn(() => [
            '/docs/a.pdf',
            '/docs/b.png',
            '/docs/a.pdf',
            '/docs/readme.txt',
        ]);
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: {
                documentPicker: { getPathsForFiles: pickerGetPathsForFiles },
                documents: { getPathsForFiles: legacyGetPathsForFiles },
            },
        });

        const onExternalFileDrop = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(null),
            totalPages: ref(7),
            selectedPages: ref([]),
            onReorder: vi.fn(),
            onExternalFileDrop,
        });
        dragDrop.dropInsertIndex.value = 3;

        dragDrop.handleExternalDrop(createDropEvent([
            '/ignored/a.pdf',
            '/ignored/b.png',
        ]));

        expect(onExternalFileDrop).toHaveBeenCalledWith(3, [
            '/docs/a.pdf',
            '/docs/b.png',
        ]);
        expect(pickerGetPathsForFiles).toHaveBeenCalledOnce();
        expect(legacyGetPathsForFiles).not.toHaveBeenCalled();
    });
});
