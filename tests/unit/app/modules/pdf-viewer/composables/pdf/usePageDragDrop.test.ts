import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import { cast } from '@tests/helpers/cast';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

vi.mock('vue', async () => ({
    ...await vi.importActual('vue'),
    onUnmounted: vi.fn(),
}));

const toastAddMock = vi.fn();

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
    beforeEach(() => {
        toastAddMock.mockClear();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('registers external dropped paths through the split picker capability', async () => {
        const legacyRegisterFilesForOpen = vi.fn(() => {
            throw new Error('legacy page drop path extraction should not be used');
        });
        const pickerRegisterFilesForOpen = vi.fn(async () => [
            '/docs/a.pdf',
            '/docs/b.png',
            '/docs/a.pdf',
            '/docs/readme.txt',
        ]);
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({
                documentPicker: { registerFilesForOpen: pickerRegisterFilesForOpen },
                documents: { registerFilesForOpen: legacyRegisterFilesForOpen },
            }),
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

        await dragDrop.handleExternalDrop(createDropEvent([
            '/ignored/a.pdf',
            '/ignored/b.png',
        ]));

        expect(onExternalFileDrop).toHaveBeenCalledWith(3, [
            '/docs/a.pdf',
            '/docs/b.png',
        ]);
        expect(pickerRegisterFilesForOpen).toHaveBeenCalledTimes(2);
        expect(legacyRegisterFilesForOpen).not.toHaveBeenCalled();
    });

    it('reports failed page-insert registration and inserts remaining valid files', async () => {
        const registerFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => {
            if (files[0]?.name === 'file-0') {
                throw new Error('page ingestion failed');
            }
            return ['/docs/b.png'];
        });
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen } }),
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

        await dragDrop.handleExternalDrop(createDropEvent([
            '/ignored/a.pdf',
            '/ignored/b.png',
        ]));

        expect(toastAddMock).toHaveBeenCalledWith({
            color: 'error',
            title: 'errors.file.open',
            description: 'page ingestion failed',
        });
        expect(onExternalFileDrop).toHaveBeenCalledWith(3, ['/docs/b.png']);
    });
});
