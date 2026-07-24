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
import { cast } from '@tests/helpers/cast';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

type TCapturedListener = (event: DragEvent) => void;

interface ICapturedListeners {
    dragover?: TCapturedListener;
    drop?: TCapturedListener;
}

let capturedListeners: ICapturedListeners = {};
const toastAddMock = vi.fn();

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
    const files = paths.map((path, index) => cast<File>({
        name: `file-${index}`,
        path,
    }));
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
        toastAddMock.mockClear();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens supported dropped files', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});
        const pickerRegisterFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => files.map((file) =>
            file.name === 'file-0' ? '/docs/a.pdf' : '/docs/b.djvu',
        ));

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({documentPicker: { registerFilesForOpen: pickerRegisterFilesForOpen }}),
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
        expect(pickerRegisterFilesForOpen).toHaveBeenCalledTimes(2);
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen: vi.fn(async () => ['/docs/readme.txt']) } }),
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
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen: vi.fn(async () => ['/docs/a.pdf']) } }),
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

        const documentPicker = { registerFilesForOpen: vi.fn(async (files: Array<{ name: string }>) => files.map((file) =>
            file.name === 'file-0' ? '/docs/a.pdf' : '/docs/b.png',
        )) };

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker }),
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

    it('reports failed dropped-file registration and opens remaining valid files', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});
        const registerFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => {
            if (files[0]?.name === 'file-0') {
                throw new Error('ingestion failed');
            }
            return ['/docs/b.pdf'];
        });

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen } }),
        });

        useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.pdf',
        ]));

        await flushDropQueue();

        expect(toastAddMock).toHaveBeenCalledWith({
            color: 'error',
            title: 'errors.file.open',
            description: 'ingestion failed',
        });
        expect(openPathsInAppropriateTab).toHaveBeenCalledWith(['/docs/b.pdf']);
    });
});
