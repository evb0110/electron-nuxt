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
            delete capturedListeners.dragover;
        }

        if (event === 'drop') {
            delete capturedListeners.drop;
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
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn((file: { name: string }) => {
                if (file.name === 'file-0') {
                    return '/docs/a.pdf';
                }
                return '/docs/b.djvu';
            }) } },
        });

        useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]));

        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledWith([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]);
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn(() => '/docs/readme.txt') } },
        });

        useExternalFileDrop({ openPathsInAppropriateTab });

        const nonFileEvent = createDragEvent(['/docs/readme.txt'], ['text/plain']);
        capturedListeners.dragover?.(nonFileEvent);
        capturedListeners.drop?.(nonFileEvent);

        const fileEvent = createDragEvent(['/docs/readme.txt']);
        capturedListeners.drop?.(fileEvent);
        await Promise.resolve();

        expect(nonFileEvent.preventDefault).not.toHaveBeenCalled();
        expect(openPathsInAppropriateTab).not.toHaveBeenCalled();
    });

    it('still handles valid file drops that were already prevented upstream', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { documents: { getPathForFile: vi.fn(() => '/docs/a.pdf') } },
        });

        useExternalFileDrop({ openPathsInAppropriateTab });

        const event = createDragEvent(
            ['/docs/a.pdf'],
            ['Files'],
            { defaultPrevented: true },
        );

        capturedListeners.drop?.(event);
        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledWith(['/docs/a.pdf']);
    });

    it('stops processing queued paths after cleanup', async () => {
        let releaseFirstPathBarrier!: () => void;
        const firstBatchOpened = new Promise<void>((resolve) => {
            releaseFirstPathBarrier = resolve;
        });
        const openPathsInAppropriateTab = vi.fn(async (paths: string[]) => {
            if (paths.includes('/docs/a.pdf')) {
                await firstBatchOpened;
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

        const { cleanup } = useExternalFileDrop({ openPathsInAppropriateTab });

        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.png',
        ]));

        await flushDropQueue();
        expect(openPathsInAppropriateTab).toHaveBeenCalledWith([
            '/docs/a.pdf',
            '/docs/b.png',
        ]);

        cleanup();
        releaseFirstPathBarrier();
        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(1);
    });
});
