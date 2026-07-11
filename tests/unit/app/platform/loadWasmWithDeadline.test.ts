import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';

describe('loadWasmWithDeadline', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('aborts a stalled WASM fetch at the deadline', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        }));
        vi.stubGlobal('fetch', fetchMock);

        const load = loadWasmWithDeadline('/stalled.wasm', {}, 25);
        const rejection = load.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(25);

        await expect(rejection).resolves.toMatchObject({
            name: 'TimeoutError',
            message: 'WASM module load timed out after 25ms',
        });
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });
});
