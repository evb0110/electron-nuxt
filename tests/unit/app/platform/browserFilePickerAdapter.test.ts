import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('browser file picker adapter', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('aborts a writer when close times out before reporting the save as failed', async () => {
        vi.useFakeTimers();
        let aborted = false;
        let committed = false;
        let releaseClose!: () => void;
        const close = vi.fn(() => new Promise<void>(resolve => {
            releaseClose = () => {
                if (!aborted) {
                    committed = true;
                }
                resolve();
            };
        }));
        const abort = vi.fn(async () => {
            aborted = true;
        });
        const writable = Object.assign(new WritableStream(), {
            abort,
            close,
            seek: vi.fn(async (_position: number) => {}),
            truncate: vi.fn(async (_size: number) => {}),
            write: vi.fn(async (_data: FileSystemWriteChunkType) => {}),
        }) satisfies FileSystemWritableFileStream;
        const handle = {
            kind: 'file',
            name: 'timed-out.pdf',
            isSameEntry: vi.fn(async (_other: FileSystemHandle) => false),
            getFile: vi.fn(async () => new File([], 'timed-out.pdf')),
            createSyncAccessHandle: vi.fn(async () => {
                throw new Error('Synchronous access is not part of this writer fixture');
            }),
            createWritable: vi.fn(async () => writable),
        } satisfies FileSystemFileHandle;
        const {writeBytesToHandle} = await import('@app/platform/browser-api/browserFilePickerAdapter');

        const save = writeBytesToHandle(handle, Uint8Array.of(37, 80, 68, 70));
        const saveError = save.catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 12; index += 1) {
            await Promise.resolve();
        }
        expect(close).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(180_000);
        const error = await saveError;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Browser file save did not finish while waiting for closing file writer');
        expect(abort).toHaveBeenCalledOnce();

        releaseClose();
        await Promise.resolve();
        expect(committed).toBe(false);
    });
});
