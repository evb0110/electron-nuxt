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

type TCapturedListener = (event: DragEvent) => void;

interface ICapturedListeners {
    dragover?: TCapturedListener;
    drop?: TCapturedListener;
}

let capturedListeners: ICapturedListeners = {};

vi.mock('@vueuse/core', () => ({ useEventListener: vi.fn((_target: unknown, event: string, listener: TCapturedListener) => {
    if (event === 'dragover' || event === 'drop') {
        capturedListeners[event] = listener;
    }

    return () => {
        if (event === 'dragover') {
            capturedListeners.dragover = undefined;
        }

        if (event === 'drop') {
            capturedListeners.drop = undefined;
        }
    };
}) }));

function createDragEvent(
    paths: string[],
    types: string[] = ['Files'],
    options: { defaultPrevented?: boolean } = {},
) {
    const files = paths.map((_path, index) => ({ name: `file-${index}` })) as File[];
    const event = {
        defaultPrevented: options.defaultPrevented ?? false,
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
        capturedListeners = {};
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
                return '/docs/b.png';
            }) } },
        });

        useExternalFileDrop({ openPathInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.png',
        ]));

        await flushDropQueue();

        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/a.pdf');
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/b.png');
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn(() => '/docs/readme.txt') } },
        });

        useExternalFileDrop({ openPathInAppropriateTab });

        const nonFileEvent = createDragEvent(['/docs/readme.txt'], ['text/plain']);
        capturedListeners.dragover?.(nonFileEvent);
        capturedListeners.drop?.(nonFileEvent);

        const fileEvent = createDragEvent(['/docs/readme.txt']);
        capturedListeners.drop?.(fileEvent);
        await Promise.resolve();

        expect(nonFileEvent.preventDefault).not.toHaveBeenCalled();
        expect(openPathInAppropriateTab).not.toHaveBeenCalled();
    });

    it('still handles valid file drops that were already prevented upstream', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn(() => '/docs/a.pdf') } },
        });

        useExternalFileDrop({ openPathInAppropriateTab });

        const event = createDragEvent(
            ['/docs/a.pdf'],
            ['Files'],
            { defaultPrevented: true },
        );

        capturedListeners.drop?.(event);
        await flushDropQueue();

        expect(openPathInAppropriateTab).toHaveBeenCalledWith('/docs/a.pdf');
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
                return '/docs/b.png';
            }) } },
        });

        const { cleanup } = useExternalFileDrop({ openPathInAppropriateTab });

        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.png',
        ]));

        await flushDropQueue();
        expect(openPathInAppropriateTab).toHaveBeenCalledWith('/docs/a.pdf');

        cleanup();
        releaseFirstPathBarrier();
        await flushDropQueue();

        expect(openPathInAppropriateTab).not.toHaveBeenCalledWith('/docs/b.png');
    });
});
