import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';

function stubWasmResponse(contentType: string | null) {
    const bytes = Uint8Array.of(0, 97, 115, 109).buffer;
    const arrayBuffer = vi.fn(async () => bytes);
    const response = {
        ok: true,
        status: 200,
        headers: {get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null)},
        arrayBuffer,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    return {
        arrayBuffer,
        bytes,
        response,
    };
}

describe('loadWasmWithDeadline', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('compiles the response stream when the server labels it as WASM', async () => {
        const compiled = {
            instance: {},
            module: {},
        };
        const instantiateStreaming = vi.fn(async () => compiled);
        const instantiate = vi.fn();
        vi.stubGlobal('WebAssembly', {
            instantiate,
            instantiateStreaming,
        });
        const {
            arrayBuffer,
            response,
        } = stubWasmResponse('application/wasm');

        await expect(loadWasmWithDeadline('/streamed.wasm')).resolves.toBe(compiled);
        expect(instantiateStreaming).toHaveBeenCalledWith(response, {});
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(instantiate).not.toHaveBeenCalled();
    });

    it('falls back to the buffered path when the content type is not WASM', async () => {
        const compiled = {
            instance: {},
            module: {},
        };
        const instantiateStreaming = vi.fn(async () => {
            throw new TypeError('Incorrect response MIME type');
        });
        const instantiate = vi.fn(async () => compiled);
        vi.stubGlobal('WebAssembly', {
            instantiate,
            instantiateStreaming,
        });
        const {
            arrayBuffer,
            bytes,
        } = stubWasmResponse('application/octet-stream');

        await expect(loadWasmWithDeadline('/mislabelled.wasm')).resolves.toBe(compiled);
        expect(instantiateStreaming).not.toHaveBeenCalled();
        expect(arrayBuffer).toHaveBeenCalled();
        expect(instantiate).toHaveBeenCalledWith(bytes, {});
    });

    it('falls back to the buffered path when streaming instantiation is unavailable', async () => {
        const compiled = {
            instance: {},
            module: {},
        };
        const instantiate = vi.fn(async () => compiled);
        vi.stubGlobal('WebAssembly', {instantiate});
        const {arrayBuffer} = stubWasmResponse('application/wasm');

        await expect(loadWasmWithDeadline('/unsupported.wasm')).resolves.toBe(compiled);
        expect(arrayBuffer).toHaveBeenCalled();
    });

    it('does not re-read a consumed body when a labelled WASM stream fails to compile', async () => {
        const compileError = new Error('compile failed');
        const instantiateStreaming = vi.fn(async () => {
            throw compileError;
        });
        const instantiate = vi.fn();
        vi.stubGlobal('WebAssembly', {
            instantiate,
            instantiateStreaming,
        });
        const {arrayBuffer} = stubWasmResponse('application/wasm; charset=binary');

        await expect(loadWasmWithDeadline('/corrupt.wasm')).rejects.toBe(compileError);
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(instantiate).not.toHaveBeenCalled();
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
