import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const NativeWebAssembly = WebAssembly;
const wasmGlobalMockBase = {Memory: NativeWebAssembly.Memory};
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: loggerWarn}}));

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

function decodeInputAt(request: Uint8Array, offset: number) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
    const name = new TextDecoder().decode(request.slice(offset, offset + nameLength));
    offset += nameLength;
    const data = request.slice(offset, offset + dataLength);
    offset += dataLength;
    return {
        data,
        name,
        offset,
    };
}

function decodeV4FirstPageSpec(request: Uint8Array) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    let offset = 4 + (6 * 4);
    const kind = view.getUint32(offset, true);
    offset += 4;
    const widthPoints = view.getFloat64(offset, true);
    offset += 8;
    const heightPoints = view.getFloat64(offset, true);
    offset += 8;
    const jpegQuality = view.getUint32(offset, true);
    offset += 4;
    const ppiCap = view.getUint32(offset, true);
    offset += 4;
    const background = decodeInputAt(request, offset);
    const mask = decodeInputAt(request, background.offset);
    offset = mask.offset;
    const foregroundColor = [
        view.getUint32(offset, true),
        view.getUint32(offset + 4, true),
        view.getUint32(offset + 8, true),
    ];
    return {
        background: {
            data: background.data,
            name: background.name,
        },
        foregroundColor,
        heightPoints,
        jpegQuality,
        kind,
        mask: {
            data: mask.data,
            name: mask.name,
        },
        ppiCap,
        widthPoints,
    };
}

function createWasmExportsMock(options: {
    allocThrows?: boolean;
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
                if (options.allocThrows) {
                    throw new Error('alloc failed');
                }
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
        vi.clearAllMocks();
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
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: instantiateMock,
        });
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

    it('encodes layered page specs as a version 4 WASM request', async () => {
        const wasmMock = createWasmExportsMock({output: new Uint8Array([
            4,
            5,
            6,
        ])});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const background = new Uint8Array([
            0x50,
            0x36,
        ]);
        const mask = new Uint8Array([
            0x50,
            0x34,
        ]);
        const result = await tryCombineImageInputsWithWasm([], {pageSpecs: [{
            kind: 'layered-color',
            pageSize: {
                widthPoints: 310.32,
                heightPoints: 471.84,
            },
            jpegQuality: 80,
            ppiCap: 300,
            foregroundColor: [
                128,
                16,
                16,
            ],
            background: {
                fileName: 'background.ppm',
                data: background,
            },
            mask: {
                fileName: 'mask.pbm',
                data: mask,
            },
        }]});

        expect(result).toEqual(new Uint8Array([
            4,
            5,
            6,
        ]));
        const request = wasmMock.capturedRequest();
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(new TextDecoder().decode(request.slice(0, 4))).toBe('EPIC');
        expect(view.getUint32(4, true)).toBe(4);
        expect(view.getUint32(4 + (5 * 4), true)).toBe(1);
        expect(decodeV4FirstPageSpec(request)).toEqual({
            background: {
                data: background,
                name: 'background.ppm',
            },
            foregroundColor: [
                128,
                16,
                16,
            ],
            heightPoints: 471.84,
            jpegQuality: 80,
            kind: 4,
            mask: {
                data: mask,
                name: 'mask.pbm',
            },
            ppiCap: 300,
            widthPoints: 310.32,
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
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toBeNull();
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
        expect(loggerWarn).toHaveBeenCalledWith(
            'browser-wasm',
            'PDF image combine WASM failed; falling back to pdf-lib',
            {
                error: 'wasm failed',
                resultCode: -1,
            },
        );
    });

    it('falls back when WASM allocation throws before a pointer is available', async () => {
        const wasmMock = createWasmExportsMock({allocThrows: true});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toBeNull();
        expect(wasmMock.free).not.toHaveBeenCalled();
    });
});
