import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';

function cast<T>(obj: unknown): T {
    return obj as T;
}

interface ICapturedDropZoneOptions {
    onDrop?: (files: File[] | null, event: DragEvent) => void;
    onOver?: (files: File[] | null, event: DragEvent) => void;
}

let capturedDropZoneOptions: ICapturedDropZoneOptions = {};

vi.mock('@vueuse/core', () => ({ useDropZone: vi.fn((_target: unknown, options?: ICapturedDropZoneOptions | ((files: File[] | null, event: DragEvent) => void)) => {
    if (typeof options === 'function') {
        capturedDropZoneOptions = { onDrop: options };
    } else {
        capturedDropZoneOptions = options ?? {};
    }

    return {
        files: { value: null },
        isOverDropZone: { value: false },
    };
}) }));

function createDragEvent(paths: string[], types: string[] = ['Files']) {
    const files = paths.map((_path, index) => ({ name: `file-${index}` })) as File[];
    const event = {
        defaultPrevented: false,
        target: null,
        dataTransfer: {
            types,
            files,
            dropEffect: 'none',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
    return cast<DragEvent>(event);
}

async function flushDropQueue() {
    await Promise.resolve();
    await Promise.resolve();
    await delay(0);
}

describe('useExternalFileDrop', () => {
    beforeEach(() => {
        capturedDropZoneOptions = {};
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens supported dropped files', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn((file: { name: string }) => {
                if (file.name === 'file-0') {
                    return '/docs/a.pdf';
                }
                return '/docs/b.djvu';
            }) } },
        });

        useExternalFileDrop({ openPathInAppropriateTab });
        capturedDropZoneOptions.onDrop?.(null, createDragEvent([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]));

        await flushDropQueue();

        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/a.pdf');
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/b.djvu');
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn(() => '/docs/readme.txt') } },
        });

        useExternalFileDrop({ openPathInAppropriateTab });

        const nonFileEvent = createDragEvent(['/docs/readme.txt'], ['text/plain']);
        capturedDropZoneOptions.onOver?.(null, nonFileEvent);
        capturedDropZoneOptions.onDrop?.(null, nonFileEvent);

        const fileEvent = createDragEvent(['/docs/readme.txt']);
        capturedDropZoneOptions.onDrop?.(null, fileEvent);
        await Promise.resolve();

        expect(nonFileEvent.preventDefault).not.toHaveBeenCalled();
        expect(openPathInAppropriateTab).not.toHaveBeenCalled();
    });

    it('stops processing queued paths after cleanup', async () => {
        let releaseFirstPathBarrier!: () => void;
        const firstPathOpened = new Promise<void>((resolve) => {
            releaseFirstPathBarrier = resolve;
        });
        const openPathInAppropriateTab = vi.fn(async (path: string) => {
            if (path.endsWith('a.pdf')) {
                await firstPathOpened;
            }
        });

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn((file: { name: string }) => {
                if (file.name === 'file-0') {
                    return '/docs/a.pdf';
                }
                return '/docs/b.djvu';
            }) } },
        });

        const { cleanup } = useExternalFileDrop({ openPathInAppropriateTab });

        capturedDropZoneOptions.onDrop?.(null, createDragEvent([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]));

        await flushDropQueue();
        expect(openPathInAppropriateTab).toHaveBeenCalledWith('/docs/a.pdf');

        cleanup();
        releaseFirstPathBarrier();
        await flushDropQueue();

        expect(openPathInAppropriateTab).not.toHaveBeenCalledWith('/docs/b.djvu');
    });
});
