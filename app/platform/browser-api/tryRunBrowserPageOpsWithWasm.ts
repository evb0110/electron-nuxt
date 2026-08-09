import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequestType,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import type { ICropMargins } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import {
    isNativeErrorEnvelope,
    type INativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';

interface IPdfPageOpsWasmExports {
    memory: WebAssembly.Memory;
    evb_pdf_page_ops_alloc(len: number): number;
    evb_pdf_page_ops_free(pointer: number, capacity: number): void;
    evb_pdf_page_ops_run(requestPointer: number, requestLen: number): number;
    evb_pdf_page_ops_output_ptr(): number;
    evb_pdf_page_ops_output_len(): number;
    evb_pdf_page_ops_error_ptr(): number;
    evb_pdf_page_ops_error_len(): number;
}

const PDF_PAGE_OPS_WASM_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

type TBrowserPageOpsWasmRequestType = TBrowserPageOpsWorkerRequestType;

type TBrowserPageOpsWasmRequest = {
    [K in TBrowserPageOpsWasmRequestType]: {
        type: K;
        payload: IBrowserPageOpsWorkerRequestMap[K];
    };
}[TBrowserPageOpsWasmRequestType];

const REQUEST_MAGIC = 'EPPO';
const REQUEST_VERSION = 1;
const WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';
const REQUEST_HEADER_BYTES = 4 + (8 * 4) + (4 * 8);

const OP_DELETE_PAGES = 1;
const OP_EXTRACT_PAGES = 2;
const OP_REORDER_PAGES = 3;
const OP_INSERT_PAGES = 4;
const OP_ROTATE = 5;
const OP_CROP = 6;
const OP_REMOVE_CROP = 7;
const OP_GET_PAGE_GEOMETRY = 8;

const RESPONSE_MUTATION = 1;
const RESPONSE_GEOMETRY = 2;
const MAX_U32 = 0xffff_ffff;

let wasmExportsPromise: Promise<IPdfPageOpsWasmExports | null> | null = null;

export interface IBrowserPageOpsWasmFailure {
    status: 'failed';
    error: INativeErrorEnvelope;
}

export function isBrowserPageOpsWasmFailure(value: unknown): value is IBrowserPageOpsWasmFailure {
    return typeof value === 'object'
        && value !== null
        && 'status' in value
        && value.status === 'failed'
        && 'error' in value
        && isNativeErrorEnvelope(value.error);
}

function createWasmFailure(
    code: TNativeErrorCode,
    message: string,
): IBrowserPageOpsWasmFailure {
    return {
        status: 'failed',
        error: {
            code,
            message,
        },
    };
}

function isWasmNumberFunction(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

function getPdfPageOpsWasmExports(exports: WebAssembly.Exports): IPdfPageOpsWasmExports | null {
    const {
        memory,
        evb_pdf_page_ops_alloc: alloc,
        evb_pdf_page_ops_free: free,
        evb_pdf_page_ops_run: run,
        evb_pdf_page_ops_output_ptr: outputPtr,
        evb_pdf_page_ops_output_len: outputLen,
        evb_pdf_page_ops_error_ptr: errorPtr,
        evb_pdf_page_ops_error_len: errorLen,
    } = exports;

    if (
        !(memory instanceof WebAssembly.Memory)
        || !isWasmNumberFunction(alloc)
        || !isWasmNumberFunction(free)
        || !isWasmNumberFunction(run)
        || !isWasmNumberFunction(outputPtr)
        || !isWasmNumberFunction(outputLen)
        || !isWasmNumberFunction(errorPtr)
        || !isWasmNumberFunction(errorLen)
    ) {
        return null;
    }

    return {
        memory,
        evb_pdf_page_ops_alloc: alloc,
        evb_pdf_page_ops_free: free,
        evb_pdf_page_ops_run: run,
        evb_pdf_page_ops_output_ptr: outputPtr,
        evb_pdf_page_ops_output_len: outputLen,
        evb_pdf_page_ops_error_ptr: errorPtr,
        evb_pdf_page_ops_error_len: errorLen,
    };
}

function canUsePdfPageOpsWasm() {
    return typeof WebAssembly !== 'undefined'
        && typeof fetch === 'function';
}

function resolveWasmUrl() {
    const location = globalThis.location;
    if (!location) {
        return WASM_PATH;
    }

    return new URL(WASM_PATH, location.href).toString();
}

async function loadPdfPageOpsWasm() {
    wasmExportsPromise ??= (async () => {
        try {
            const instantiated = await loadWasmWithDeadline(resolveWasmUrl());
            const instance = 'instance' in instantiated
                ? instantiated.instance
                : instantiated;
            return getPdfPageOpsWasmExports(instance.exports);
        } catch {
            return null;
        }
    })();

    return wasmExportsPromise;
}

function writeMagic(request: Uint8Array, offset: number) {
    request.set(new TextEncoder().encode(REQUEST_MAGIC), offset);
    return offset + REQUEST_MAGIC.length;
}

function toWasmU32(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
        throw new Error('Invalid page-op WASM integer field');
    }

    return value;
}

function toWasmF64(value: number) {
    if (!Number.isFinite(value)) {
        throw new Error('Invalid page-op WASM number field');
    }

    return value;
}

function writeU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + 4;
}

function writeF64(view: DataView, offset: number, value: number) {
    view.setFloat64(offset, value, true);
    return offset + 8;
}

function getOperationCode(type: TBrowserPageOpsWasmRequestType) {
    switch (type) {
        case 'deletePages':
            return OP_DELETE_PAGES;
        case 'extractPages':
            return OP_EXTRACT_PAGES;
        case 'reorderPages':
            return OP_REORDER_PAGES;
        case 'insertPages':
            return OP_INSERT_PAGES;
        case 'rotate':
            return OP_ROTATE;
        case 'crop':
            return OP_CROP;
        case 'removeCrop':
            return OP_REMOVE_CROP;
        case 'getPageGeometry':
            return OP_GET_PAGE_GEOMETRY;
    }
}

function getRequestPages(request: TBrowserPageOpsWasmRequest): number[] {
    switch (request.type) {
        case 'deletePages':
        case 'extractPages':
        case 'rotate':
        case 'crop':
        case 'removeCrop':
            return request.payload.pages;
        case 'reorderPages':
            return request.payload.newOrder;
        case 'insertPages':
        case 'getPageGeometry':
            return [];
    }
}

function getRequestData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    return request.payload.data;
}

function getInsertionData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    return request.type === 'insertPages'
        ? request.payload.insertionData
        : new Uint8Array();
}

function getPageNumber(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'getPageGeometry'
        ? request.payload.pageNumber
        : 0;
}

function getAfterPage(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'insertPages'
        ? request.payload.afterPage
        : 0;
}

function getAngle(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'rotate'
        ? request.payload.angle
        : 0;
}

function getMargins(request: TBrowserPageOpsWasmRequest): ICropMargins {
    if (request.type !== 'crop') {
        return {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        };
    }

    return request.payload.margins;
}

function buildWasmRequest(request: TBrowserPageOpsWasmRequest) {
    const data = getRequestData(request);
    const insertionData = getInsertionData(request);
    const pages = getRequestPages(request).map(toWasmU32);
    const pageNumber = toWasmU32(getPageNumber(request));
    const afterPage = toWasmU32(getAfterPage(request));
    const angle = toWasmU32(getAngle(request));
    const dataLength = toWasmU32(data.byteLength);
    const insertionDataLength = toWasmU32(insertionData.byteLength);
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(
        REQUEST_HEADER_BYTES
        + (pages.length * 4)
        + dataLength
        + insertionDataLength,
    );
    const view = new DataView(output.buffer);
    const margins = getMargins(request);
    let offset = 0;

    offset = writeMagic(output, offset);
    offset = writeU32(view, offset, REQUEST_VERSION);
    offset = writeU32(view, offset, getOperationCode(request.type));
    offset = writeU32(view, offset, pages.length);
    offset = writeU32(view, offset, pageNumber);
    offset = writeU32(view, offset, afterPage);
    offset = writeU32(view, offset, angle);
    offset = writeF64(view, offset, toWasmF64(margins.top));
    offset = writeF64(view, offset, toWasmF64(margins.bottom));
    offset = writeF64(view, offset, toWasmF64(margins.left));
    offset = writeF64(view, offset, toWasmF64(margins.right));
    offset = writeU32(view, offset, dataLength);
    offset = writeU32(view, offset, insertionDataLength);

    for (const page of pages) {
        offset = writeU32(view, offset, page);
    }

    output.set(data, offset);
    offset += dataLength;
    output.set(insertionData, offset);

    return output;
}

function copyWasmBytes(
    exports: IPdfPageOpsWasmExports,
    pointer: number,
    len: number,
) {
    return new Uint8Array(exports.memory.buffer, pointer, len).slice();
}

function readWasmError(exports: IPdfPageOpsWasmExports) {
    const pointer = exports.evb_pdf_page_ops_error_ptr();
    const len = exports.evb_pdf_page_ops_error_len();
    if (len === 0) {
        return null;
    }

    return new TextDecoder().decode(copyWasmBytes(exports, pointer, len));
}

function readWasmFailure(
    type: TBrowserPageOpsWasmRequestType,
    resultCode: number,
    exports: IPdfPageOpsWasmExports,
) {
    const encodedError = readWasmError(exports);
    const error = decodeSerializableErrorEnvelope(
        encodedError,
        isNativeErrorEnvelope,
        {allowBareJsonString: true},
    ) ?? {
        code: 'native-failure' as const,
        message: encodedError ?? `Page operation WASM failed with result code ${resultCode}`,
    };
    BrowserLogger.warn('browser-wasm', 'PDF page operation WASM failed; falling back to pdf-lib', {
        error: error.message,
        resultCode,
        type,
    });
    return createWasmFailure(error.code, error.message);
}

function readMutationResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    let offset = 4;
    const pageCount = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
    if (offset + dataLength !== output.byteLength) {
        return null;
    }

    return {
        data: toTransferableUint8Array(output.slice(offset, offset + dataLength)),
        pageCount,
    };
}

function readBox(view: DataView, offset: number) {
    return {
        box: {
            x: view.getFloat64(offset, true),
            y: view.getFloat64(offset + 8, true),
            width: view.getFloat64(offset + 16, true),
            height: view.getFloat64(offset + 24, true),
        },
        offset: offset + 32,
    };
}

function readGeometryResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    let offset = 4;
    const rotation = view.getUint32(offset, true);
    offset += 4;
    const media = readBox(view, offset);
    offset = media.offset;
    const hasCropBox = view.getUint32(offset, true) === 1;
    offset += 4;
    const crop = readBox(view, offset);
    offset = crop.offset;
    if (offset !== output.byteLength) {
        return null;
    }

    return {
        mediaBox: media.box,
        cropBox: hasCropBox ? crop.box : null,
        rotation,
    };
}

function parseWasmOutput<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    output: Uint8Array,
): IBrowserPageOpsWorkerResultMap[K] | null {
    if (output.byteLength < 4) {
        return null;
    }

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const kind = view.getUint32(0, true);
    if (type === 'getPageGeometry') {
        return kind === RESPONSE_GEOMETRY
            ? readGeometryResult(output) as IBrowserPageOpsWorkerResultMap[K] | null
            : null;
    }

    return kind === RESPONSE_MUTATION
        ? readMutationResult(output) as IBrowserPageOpsWorkerResultMap[K] | null
        : null;
}

export async function tryRunBrowserPageOpsWithWasm<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
): Promise<IBrowserPageOpsWorkerResultMap[K] | IBrowserPageOpsWasmFailure | null> {
    if (!canUsePdfPageOpsWasm()) {
        return null;
    }

    const exports = await loadPdfPageOpsWasm();
    if (!exports) {
        return null;
    }

    let pointer: number | null = null;
    let requestByteLength = 0;

    try {
        const request = buildWasmRequest({
            type,
            payload,
        } as TBrowserPageOpsWasmRequest);
        requestByteLength = request.byteLength;
        if (requestByteLength === 0 || requestByteLength > PDF_PAGE_OPS_WASM_MAX_REQUEST_BYTES) {
            return createWasmFailure('too-large', 'Page operation WASM request exceeds the admission ceiling');
        }
        pointer = exports.evb_pdf_page_ops_alloc(requestByteLength);
        if (pointer === 0) {
            pointer = null;
            return createWasmFailure('too-large', 'Page operation WASM could not allocate request memory');
        }
        new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request);
        const resultCode = exports.evb_pdf_page_ops_run(pointer, request.byteLength);
        if (resultCode !== 0) {
            return readWasmFailure(type, resultCode, exports);
        }

        const outputPointer = exports.evb_pdf_page_ops_output_ptr();
        const outputLen = exports.evb_pdf_page_ops_output_len();
        if (outputLen === 0 || outputLen > PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES) {
            return createWasmFailure(
                outputLen > PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES ? 'too-large' : 'invalid-request',
                'Page operation WASM returned an invalid output envelope',
            );
        }

        return parseWasmOutput(type, copyWasmBytes(exports, outputPointer, outputLen))
            ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
    } catch (error) {
        return createWasmFailure(
            'invalid-request',
            error instanceof Error ? error.message : 'Page operation WASM request failed',
        );
    } finally {
        if (pointer !== null) {
            exports.evb_pdf_page_ops_free(pointer, requestByteLength);
        }
    }
}
