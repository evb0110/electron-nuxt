import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const NativeWebAssembly = WebAssembly;

function createFetchMock() {
    return vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
    }));
}

function decodeRequestNameAndData(request: Uint8Array) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    let offset = 4 + (6 * 4);
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
    const name = new TextDecoder().decode(request.slice(offset, offset + nameLength));
    offset += nameLength;
    const data = request.slice(offset, offset + dataLength);
    return {
        data,
        name,
    };
}

function createWasmExportsMock(options: {
    buildResultCode?: number;
    output?: Uint8Array;
} = {}) {
    const memory = new NativeWebAssembly.Memory({initial: 1});
    const output = options.output ?? new Uint8Array([
        0x25,
        0x50,
        0x44,
        0x46,
    ]);
    let cursor = 1024;
    let capturedRequest = new Uint8Array();
    let outputPointer = 0;
    let errorPointer = 0;
    const error = new TextEncoder().encode('wasm failed');
    const free = vi.fn();
    const buildPdf = vi.fn((requestPointer: number, requestLength: number) => {
        capturedRequest = new Uint8Array(memory.buffer, requestPointer, requestLength).slice();
        if (options.buildResultCode && options.buildResultCode !== 0) {
            errorPointer = cursor;
            cursor += error.byteLength + 16;
            new Uint8Array(memory.buffer, errorPointer, error.byteLength).set(error);
            return options.buildResultCode;
        }

        outputPointer = cursor;
        cursor += output.byteLength + 16;
        new Uint8Array(memory.buffer, outputPointer, output.byteLength).set(output);
        return 0;
    });

    return {
        capturedRequest: () => capturedRequest,
        exports: {
            memory,
            evb_pdf_image_combine_alloc: vi.fn((len: number) => {
                const pointer = cursor;
                cursor += len + 16;
                return pointer;
            }),
            evb_pdf_image_combine_free: free,
            evb_pdf_image_combine_build_pdf: buildPdf,
            evb_pdf_image_combine_output_ptr: vi.fn(() => outputPointer),
            evb_pdf_image_combine_output_len: vi.fn(() => output.byteLength),
            evb_pdf_image_combine_error_ptr: vi.fn(() => errorPointer),
            evb_pdf_image_combine_error_len: vi.fn(() => error.byteLength),
        },
        free,
    };
}

describe('tryCombineImageInputsWithWasm', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.stubGlobal('location', {href: 'https://viewer.test/electron'});
    });

    it('combines supported image inputs through the WASM export', async () => {
        const fetchMock = createFetchMock();
        const wasmMock = createWasmExportsMock({output: new Uint8Array([
            9,
            8,
            7,
        ])});
        const instantiateMock = vi.fn(async () => ({instance: {exports: wasmMock.exports}}));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('WebAssembly', {instantiate: instantiateMock});
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
        }]);

        expect(result).toEqual(new Uint8Array([
            9,
            8,
            7,
        ]));
        expect(fetchMock).toHaveBeenCalledWith('https://viewer.test/wasm/evb-pdf-image-combine.wasm');
        expect(instantiateMock).toHaveBeenCalledTimes(1);
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
        const request = wasmMock.capturedRequest();
        expect(new TextDecoder().decode(request.slice(0, 4))).toBe('EPIC');
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(view.getUint32(4, true)).toBe(1);
        expect(view.getUint32(4 + (5 * 4), true)).toBe(1);
        expect(decodeRequestNameAndData(request)).toEqual({
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
            name: 'scan.png',
        });
    });

    it('skips WASM for mixed PDF inputs', async () => {
        const fetchMock = createFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'source.pdf',
            data: new Uint8Array([1]),
        }]);

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back when the WASM export rejects the image payload', async () => {
        const wasmMock = createWasmExportsMock({buildResultCode: -1});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}}))});
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toBeNull();
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
    });
});
