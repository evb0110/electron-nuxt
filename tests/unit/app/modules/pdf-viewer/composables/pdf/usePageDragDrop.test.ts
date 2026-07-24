import {
    afterEach,
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

function createDragEventTarget() {
    const windowTarget = new EventTarget();
    const body = {style: {
        cursor: '',
        userSelect: '',
    }};
    class MockHTMLElement {
        public scrollHeight = 0;
        public clientHeight = 0;
        public scrollTop = 0;

        public closest() {
            return null;
        }
    }
    const container = new MockHTMLElement();
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', {
        body,
        createElement: () => container,
    });
    vi.stubGlobal('HTMLElement', MockHTMLElement);
    vi.stubGlobal('MouseEvent', class extends Event {
        public readonly button: number;
        public readonly buttons: number;
        public readonly clientX: number;
        public readonly clientY: number;
        public readonly shiftKey: boolean;
        public readonly metaKey: boolean;
        public readonly ctrlKey: boolean;

        public constructor(type: string, init: MouseEventInit = {}) {
            super(type);
            this.button = init.button ?? 0;
            this.buttons = init.buttons ?? 0;
            this.clientX = init.clientX ?? 0;
            this.clientY = init.clientY ?? 0;
            this.shiftKey = init.shiftKey ?? false;
            this.metaKey = init.metaKey ?? false;
            this.ctrlKey = init.ctrlKey ?? false;
        }
    });

    return {
        body,
        container: document.createElement('div'),
        windowTarget,
    };
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
        const pickerRegisterFilesForOpen = vi.fn(async () => [
            '/docs/a.pdf',
            '/docs/b.png',
            '/docs/a.pdf',
            '/docs/readme.txt',
        ]);
        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({documentPicker: { registerFilesForOpen: pickerRegisterFilesForOpen }}),
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

    it('clears active thumbnail drag state when the window loses the drag', async () => {
        const {
            body,
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: () => 1,
            onReorder,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        window.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));

        expect(dragDrop.isDragging.value).toBe(true);
        expect(body.style.cursor).toBe('grabbing');

        windowTarget.dispatchEvent(new Event('blur'));

        expect(dragDrop.isDragging.value).toBe(false);
        expect(dragDrop.draggedPages.value).toEqual([]);
        expect(dragDrop.dropInsertIndex.value).toBeNull();
        expect(body.style.cursor).toBe('');
        expect(body.style.userSelect).toBe('');
        expect(dragDrop.consumeClickSkip()).toBe(true);
        expect(onReorder).not.toHaveBeenCalled();
    });

    it('cancels active thumbnail drag when mousemove reports no pressed button', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: () => 1,
            onReorder: vi.fn(),
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 0,
        }));
        expect(dragDrop.isDragging.value).toBe(true);

        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 0,
            clientX: 20,
            clientY: 0,
        }));

        expect(dragDrop.isDragging.value).toBe(false);
        expect(dragDrop.draggedPages.value).toEqual([]);
        expect(dragDrop.dropInsertIndex.value).toBeNull();
    });

    it('flushes the mouseup position before committing a page reorder', async () => {
        const {
            container,
            windowTarget,
        } = createDragEventTarget();
        const onReorder = vi.fn();
        const dragDrop = usePageDragDrop({
            containerRef: ref(container),
            totalPages: ref(3),
            selectedPages: ref([]),
            resolveDropIndex: clientY => clientY >= 100 ? 3 : 1,
            onReorder,
        });

        dragDrop.handleMouseDown(new MouseEvent('mousedown', {
            button: 0,
            clientX: 0,
            clientY: 0,
        }), 1);
        await nextTick();
        windowTarget.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 1,
            clientX: 20,
            clientY: 10,
        }));
        windowTarget.dispatchEvent(new MouseEvent('mouseup', {
            buttons: 0,
            clientX: 20,
            clientY: 100,
        }));

        expect(onReorder).toHaveBeenCalledExactlyOnceWith([
            2,
            3,
            1,
        ]);
    });
});
