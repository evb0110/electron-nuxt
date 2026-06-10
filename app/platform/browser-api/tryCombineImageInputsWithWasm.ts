import type { IBrowserPdfCombineInput } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { getBrowserFileExtension } from '@app/platform/browser-api/browserPlatformHelpers';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';

interface IPdfImageCombineWasmExports {
    memory: WebAssembly.Memory;
    evb_pdf_image_combine_alloc(len: number): number;
    evb_pdf_image_combine_free(pointer: number, capacity: number): void;
    evb_pdf_image_combine_build_pdf(requestPointer: number, requestLen: number): number;
    evb_pdf_image_combine_output_ptr(): number;
    evb_pdf_image_combine_output_len(): number;
    evb_pdf_image_combine_error_ptr(): number;
    evb_pdf_image_combine_error_len(): number;
}

const REQUEST_MAGIC = 'EPIC';
const REQUEST_VERSION = 1;
const DEFAULT_DPI = 0;
const MAX_PAGES = 500;
const MAX_PIXELS = 80_000_000;
const MAX_TIFF_FRAMES = 250;
const REQUEST_HEADER_BYTES = 4 + (6 * 4);
const INPUT_HEADER_BYTES = 8;
const WASM_PATH = '/wasm/evb-pdf-image-combine.wasm';
const WASM_IMAGE_EXTENSIONS = new Set([
    '.jpeg',
    '.jpg',
    '.png',
    '.tif',
    '.tiff',
]);

let wasmExportsPromise: Promise<IPdfImageCombineWasmExports | null> | null = null;

function canUsePdfImageCombineWasm(inputs: IBrowserPdfCombineInput[]) {
    return inputs.length > 0
        && typeof WebAssembly !== 'undefined'
        && typeof fetch === 'function'
        && inputs.every(input => WASM_IMAGE_EXTENSIONS.has(getBrowserFileExtension(input.fileName)));
}

function resolveWasmUrl() {
    const location = globalThis.location;
    if (!location) {
        return WASM_PATH;
    }

    return new URL(WASM_PATH, location.href).toString();
}

async function loadPdfImageCombineWasm() {
    wasmExportsPromise ??= (async () => {
        try {
            const response = await fetch(resolveWasmUrl());
            if (!response.ok) {
                return null;
            }
            const bytes = await response.arrayBuffer();
            const instantiated = await WebAssembly.instantiate(bytes, {});
            const instance = 'instance' in instantiated
                ? instantiated.instance
                : instantiated;
            return instance.exports as unknown as IPdfImageCombineWasmExports;
        } catch {
            return null;
        }
    })();

    return wasmExportsPromise;
}

function getEncodedName(input: IBrowserPdfCombineInput, encoder: TextEncoder) {
    return encoder.encode(input.fileName);
}

function getRequestLength(inputs: IBrowserPdfCombineInput[], encodedNames: Uint8Array[]) {
    return inputs.reduce(
        (total, input, index) => total
            + INPUT_HEADER_BYTES
            + (encodedNames[index]?.byteLength ?? 0)
            + input.data.byteLength,
        REQUEST_HEADER_BYTES,
    );
}

function writeU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + 4;
}

function buildWasmRequest(inputs: IBrowserPdfCombineInput[]) {
    const encoder = new TextEncoder();
    const encodedNames = inputs.map(input => getEncodedName(input, encoder));
    const request = new Uint8Array(getRequestLength(inputs, encodedNames));
    const view = new DataView(request.buffer);
    let offset = 0;

    request.set(encoder.encode(REQUEST_MAGIC), offset);
    offset += REQUEST_MAGIC.length;
    offset = writeU32(view, offset, REQUEST_VERSION);
    offset = writeU32(view, offset, DEFAULT_DPI);
    offset = writeU32(view, offset, MAX_PAGES);
    offset = writeU32(view, offset, MAX_PIXELS);
    offset = writeU32(view, offset, MAX_TIFF_FRAMES);
    offset = writeU32(view, offset, inputs.length);

    for (const [
        index,
        input,
    ] of inputs.entries()) {
        const name = encodedNames[index]!;
        offset = writeU32(view, offset, name.byteLength);
        offset = writeU32(view, offset, input.data.byteLength);
        request.set(name, offset);
        offset += name.byteLength;
        request.set(input.data, offset);
        offset += input.data.byteLength;
    }

    return request;
}

function copyWasmBytes(
    exports: IPdfImageCombineWasmExports,
    pointer: number,
    len: number,
) {
    return new Uint8Array(exports.memory.buffer, pointer, len).slice();
}

function readWasmError(exports: IPdfImageCombineWasmExports) {
    const pointer = exports.evb_pdf_image_combine_error_ptr();
    const len = exports.evb_pdf_image_combine_error_len();
    if (len === 0) {
        return null;
    }

    return new TextDecoder().decode(copyWasmBytes(exports, pointer, len));
}

export async function tryCombineImageInputsWithWasm(
    inputs: IBrowserPdfCombineInput[],
): Promise<Uint8Array | null> {
    if (!canUsePdfImageCombineWasm(inputs)) {
        return null;
    }

    const exports = await loadPdfImageCombineWasm();
    if (!exports) {
        return null;
    }

    const request = buildWasmRequest(inputs);
    const pointer = exports.evb_pdf_image_combine_alloc(request.byteLength);

    try {
        new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request);
        const resultCode = exports.evb_pdf_image_combine_build_pdf(pointer, request.byteLength);
        if (resultCode !== 0) {
            readWasmError(exports);
            return null;
        }

        const outputPointer = exports.evb_pdf_image_combine_output_ptr();
        const outputLen = exports.evb_pdf_image_combine_output_len();
        if (outputLen === 0) {
            return null;
        }

        return toTransferableUint8Array(copyWasmBytes(exports, outputPointer, outputLen));
    } catch {
        return null;
    } finally {
        exports.evb_pdf_image_combine_free(pointer, request.byteLength);
    }
}
