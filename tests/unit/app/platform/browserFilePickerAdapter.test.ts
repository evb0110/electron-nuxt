import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {cast} from '@tests/helpers/cast';

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
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'timed-out.pdf',
            createWritable: vi.fn(async () => ({
                write: vi.fn(async () => {}),
                close,
                abort,
            })),
        });
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
