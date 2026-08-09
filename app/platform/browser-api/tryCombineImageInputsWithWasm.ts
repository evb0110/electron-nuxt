import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombinePageSize,
    IBrowserPdfCombineWasmImagePreprocessing,
    IBrowserPdfCombineWasmPageSpec,
    TBrowserPdfCombineWasmPageKind,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { getBrowserFileExtension } from '@app/platform/browser-api/browserPlatformHelpers';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import {
    isNativeErrorEnvelope,
    type INativeErrorEnvelope,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';

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
const REQUEST_VERSION_PAGE_SPECS = 4;
const WASM_PAGE_KIND_CODES: Record<TBrowserPdfCombineWasmPageKind, number> = {
    image: 1,
    mask: 2,
    layered: 3,
    'layered-color': 4,
};
const DEFAULT_DPI = 0;
const MAX_PAGES = 500;
const MAX_PIXELS = 80_000_000;
const MAX_TIFF_FRAMES = 250;
const REQUEST_HEADER_BYTES = 4 + (6 * 4);
const INPUT_HEADER_BYTES = 8;
const PAGE_SPEC_HEADER_BYTES = 4 + (2 * 8) + (2 * 4);
const PAGE_SPEC_FOREGROUND_COLOR_BYTES = 3 * 4;
const WASM_PATH = '/wasm/evb-pdf-image-combine.wasm';
const WASM_IMAGE_EXTENSIONS = new Set([
    '.jpeg',
    '.jpg',
    '.pgm',
    '.png',
    '.ppm',
    '.tif',
    '.tiff',
]);
const WASM_PREPROCESSABLE_IMAGE_EXTENSIONS = new Set([
    '.pgm',
    '.ppm',
]);
const WASM_LAYER_IMAGE_EXTENSIONS = new Set([
    '.jpeg',
    '.jpg',
    '.pgm',
    '.png',
    '.ppm',
]);
const WASM_MASK_EXTENSIONS = new Set(['.pbm']);

let wasmExportsPromise: Promise<IPdfImageCombineWasmExports | null> | null = null;

export type TBrowserPdfCombineWasmOutcome =
    | {
        status: 'success';
        data: Uint8Array
    }
    | {status: 'unsupported' | 'unavailable'}
    | {
        status: 'fatal';
        error: INativeErrorEnvelope
    };

function isWasmNumberFunction(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

function getPdfImageCombineWasmExports(exports: WebAssembly.Exports): IPdfImageCombineWasmExports | null {
    const {
        memory,
        evb_pdf_image_combine_alloc: alloc,
        evb_pdf_image_combine_free: free,
        evb_pdf_image_combine_build_pdf: buildPdf,
        evb_pdf_image_combine_output_ptr: outputPtr,
        evb_pdf_image_combine_output_len: outputLen,
        evb_pdf_image_combine_error_ptr: errorPtr,
        evb_pdf_image_combine_error_len: errorLen,
    } = exports;

    if (
        !(memory instanceof WebAssembly.Memory)
        || !isWasmNumberFunction(alloc)
        || !isWasmNumberFunction(free)
        || !isWasmNumberFunction(buildPdf)
        || !isWasmNumberFunction(outputPtr)
        || !isWasmNumberFunction(outputLen)
        || !isWasmNumberFunction(errorPtr)
        || !isWasmNumberFunction(errorLen)
    ) {
        return null;
    }

    return {
        memory,
        evb_pdf_image_combine_alloc: alloc,
        evb_pdf_image_combine_free: free,
        evb_pdf_image_combine_build_pdf: buildPdf,
        evb_pdf_image_combine_output_ptr: outputPtr,
        evb_pdf_image_combine_output_len: outputLen,
        evb_pdf_image_combine_error_ptr: errorPtr,
        evb_pdf_image_combine_error_len: errorLen,
    };
}

function hasNetpbmJpegProcessing(options: IBrowserPdfCombineWasmImagePreprocessing | undefined) {
    return (options?.ppiCap ?? 0) > 0 || (options?.jpegQuality ?? 0) > 0;
}

function isSupportedGenericImageInput(input: IBrowserPdfCombineInput) {
    return WASM_IMAGE_EXTENSIONS.has(getBrowserFileExtension(input.fileName));
}

function isSupportedPreprocessableImageInput(input: IBrowserPdfCombineInput) {
    return WASM_PREPROCESSABLE_IMAGE_EXTENSIONS.has(getBrowserFileExtension(input.fileName));
}

function isSupportedLayerColorInput(input: IBrowserPdfCombineInput | undefined) {
    return Boolean(input && WASM_LAYER_IMAGE_EXTENSIONS.has(getBrowserFileExtension(input.fileName)));
}

function isSupportedMaskInput(input: IBrowserPdfCombineInput | undefined) {
    return Boolean(input && WASM_MASK_EXTENSIONS.has(getBrowserFileExtension(input.fileName)));
}

function pageSpecInputs(spec: IBrowserPdfCombineWasmPageSpec): IBrowserPdfCombineInput[] {
    switch (spec.kind) {
        case 'image':
            return spec.image ? [spec.image] : [];
        case 'mask':
            return spec.mask ? [spec.mask] : [];
        case 'layered':
            return spec.background && spec.mask ? [
                spec.background,
                spec.mask,
            ] : [];
        case 'layered-color':
            return spec.background && spec.mask
                ? [
                    spec.background,
                    spec.mask,
                ]
                : [];
    }
}

function isValidForegroundColor(value: readonly number[] | undefined) {
    return value?.length === 3
        && value.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255);
}

function canUsePageSpec(spec: IBrowserPdfCombineWasmPageSpec) {
    if (spec.kind === 'image') {
        if (!spec.image) {
            return false;
        }
        return (spec.ppiCap ?? 0) > 0 || (spec.jpegQuality ?? 0) > 0
            ? isSupportedPreprocessableImageInput(spec.image)
            : isSupportedGenericImageInput(spec.image);
    }
    if (spec.kind === 'mask') {
        return isSupportedMaskInput(spec.mask);
    }
    if (spec.kind === 'layered') {
        return isSupportedLayerColorInput(spec.background) && isSupportedMaskInput(spec.mask);
    }
    return (
        isSupportedLayerColorInput(spec.background)
        && isSupportedMaskInput(spec.mask)
        && isValidForegroundColor(spec.foregroundColor)
    );
}

function shouldBuildGeneratedImagePageSpecs(
    inputs: IBrowserPdfCombineInput[],
    options: IBrowserPdfCombineWasmImagePreprocessing | undefined,
) {
    return inputs.length > 0
        && Boolean(
            options
            && (
                hasNetpbmJpegProcessing(options)
                || (options.pageSizes?.length ?? 0) > 0
            ),
        );
}

function resolveRequestPageSpecs(
    inputs: IBrowserPdfCombineInput[],
    options: IBrowserPdfCombineWasmImagePreprocessing | undefined,
): IBrowserPdfCombineWasmPageSpec[] | null {
    if (options?.pageSpecs?.length) {
        return options.pageSpecs;
    }
    if (!shouldBuildGeneratedImagePageSpecs(inputs, options)) {
        return null;
    }
    if (!options?.pageSizes || options.pageSizes.length < inputs.length) {
        return null;
    }
    const pageSizes = options.pageSizes;

    const specs: IBrowserPdfCombineWasmPageSpec[] = [];
    for (const [
        index,
        input,
    ] of inputs.entries()) {
        const pageSize = pageSizes[index];
        if (!pageSize) {
            return null;
        }
        specs.push({
            kind: 'image',
            pageSize,
            ...(options.jpegQuality === undefined ? {} : {jpegQuality: options.jpegQuality}),
            ...(options.ppiCap === undefined ? {} : {ppiCap: options.ppiCap}),
            image: input,
        });
    }
    return specs;
}

function canUsePdfImageCombineWasm(
    inputs: IBrowserPdfCombineInput[],
    options: IBrowserPdfCombineWasmImagePreprocessing | undefined,
) {
    if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') {
        return false;
    }
    const pageSpecs = resolveRequestPageSpecs(inputs, options);
    if (pageSpecs) {
        return pageSpecs.length > 0 && pageSpecs.every(canUsePageSpec);
    }
    return inputs.length > 0 && inputs.every(isSupportedGenericImageInput);
}

function resolveWasmUrl() {
    const location = globalThis.location;
    if (!location) {
        return WASM_PATH;
    }

    return new URL(WASM_PATH, location.href).toString();
}

async function loadPdfImageCombineWasm() {
    const pending = wasmExportsPromise ?? (async () => {
        try {
            const instantiated = await loadWasmWithDeadline(resolveWasmUrl());
            const instance = 'instance' in instantiated
                ? instantiated.instance
                : instantiated;
            return getPdfImageCombineWasmExports(instance.exports);
        } catch {
            return null;
        }
    })();
    wasmExportsPromise = pending;

    const loaded = await pending;
    if (!loaded && wasmExportsPromise === pending) {
        wasmExportsPromise = null;
    }
    return loaded;
}

function getEncodedName(input: IBrowserPdfCombineInput, encoder: TextEncoder) {
    return encoder.encode(input.fileName);
}

interface IEncodedWasmInput {
    input: IBrowserPdfCombineInput;
    name: Uint8Array;
}

function getV1RequestLength(
    inputs: IBrowserPdfCombineInput[],
    encodedNames: Uint8Array[],
) {
    return inputs.reduce(
        (total, input, index) => total
            + INPUT_HEADER_BYTES
            + (encodedNames[index]?.byteLength ?? 0)
            + input.data.byteLength,
        REQUEST_HEADER_BYTES,
    );
}

function getV4RequestLength(
    pageSpecs: IBrowserPdfCombineWasmPageSpec[],
    encodedPageInputs: IEncodedWasmInput[][],
) {
    return encodedPageInputs.reduce(
        (total, inputs, index) => total
            + PAGE_SPEC_HEADER_BYTES
            + (pageSpecs[index]?.kind === 'layered-color' ? PAGE_SPEC_FOREGROUND_COLOR_BYTES : 0)
            + inputs.reduce(
                (pageTotal, input) => pageTotal
                    + INPUT_HEADER_BYTES
                    + input.name.byteLength
                    + input.input.data.byteLength,
                0,
            ),
        REQUEST_HEADER_BYTES,
    );
}

function writeU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + 4;
}

function writeF64(view: DataView, offset: number, value: number) {
    view.setFloat64(offset, value, true);
    return offset + 8;
}

function integerOrDefault(value: number | undefined, defaultValue: number) {
    return typeof value === 'number' && Number.isInteger(value) ? value : defaultValue;
}

function boundedU32OrDefault(value: number | undefined, defaultValue: number) {
    const integer = integerOrDefault(value, defaultValue);
    return Math.min(0xffffffff, Math.max(0, integer));
}

function isValidPageSize(pageSize: IBrowserPdfCombinePageSize | undefined) {
    if (
        !pageSize
        || !Number.isFinite(pageSize.widthPoints)
        || !Number.isFinite(pageSize.heightPoints)
        || pageSize.widthPoints <= 0
        || pageSize.heightPoints <= 0
    ) {
        return false;
    }
    return true;
}

function writeRequestHeader(
    request: Uint8Array,
    view: DataView,
    version: number,
    itemCount: number,
) {
    const encoder = new TextEncoder();
    let offset = 0;

    request.set(encoder.encode(REQUEST_MAGIC), offset);
    offset += REQUEST_MAGIC.length;
    offset = writeU32(view, offset, version);
    offset = writeU32(view, offset, DEFAULT_DPI);
    offset = writeU32(view, offset, MAX_PAGES);
    offset = writeU32(view, offset, MAX_PIXELS);
    offset = writeU32(view, offset, MAX_TIFF_FRAMES);
    offset = writeU32(view, offset, itemCount);
    return offset;
}

function writeInput(
    request: Uint8Array,
    view: DataView,
    offset: number,
    input: IEncodedWasmInput,
) {
    offset = writeU32(view, offset, input.name.byteLength);
    offset = writeU32(view, offset, input.input.data.byteLength);
    request.set(input.name, offset);
    offset += input.name.byteLength;
    request.set(input.input.data, offset);
    return offset + input.input.data.byteLength;
}

function buildV1WasmRequest(
    inputs: IBrowserPdfCombineInput[],
) {
    const encoder = new TextEncoder();
    const encodedNames = inputs.map(input => getEncodedName(input, encoder));
    const request = new Uint8Array(getV1RequestLength(inputs, encodedNames));
    const view = new DataView(request.buffer);
    let offset = writeRequestHeader(request, view, REQUEST_VERSION, inputs.length);

    for (const [
        index,
        input,
    ] of inputs.entries()) {
        offset = writeInput(request, view, offset, {
            input,
            name: encodedNames[index]!,
        });
    }

    return request;
}

function buildV3WasmRequest(
    pageSpecs: IBrowserPdfCombineWasmPageSpec[],
    options?: IBrowserPdfCombineWasmImagePreprocessing,
) {
    const encoder = new TextEncoder();
    const encodedPageInputs = pageSpecs.map(spec => pageSpecInputs(spec).map(input => ({
        input,
        name: getEncodedName(input, encoder),
    })));
    const request = new Uint8Array(getV4RequestLength(pageSpecs, encodedPageInputs));
    const view = new DataView(request.buffer);
    let offset = writeRequestHeader(request, view, REQUEST_VERSION_PAGE_SPECS, pageSpecs.length);

    for (const [
        index,
        spec,
    ] of pageSpecs.entries()) {
        if (!isValidPageSize(spec.pageSize)) {
            throw new Error('Invalid WASM page spec size');
        }
        offset = writeU32(view, offset, WASM_PAGE_KIND_CODES[spec.kind]);
        offset = writeF64(view, offset, spec.pageSize.widthPoints);
        offset = writeF64(view, offset, spec.pageSize.heightPoints);
        offset = writeU32(view, offset, boundedU32OrDefault(spec.jpegQuality, integerOrDefault(options?.jpegQuality, 0)));
        offset = writeU32(view, offset, boundedU32OrDefault(spec.ppiCap, integerOrDefault(options?.ppiCap, 0)));
        for (const input of encodedPageInputs[index] ?? []) {
            offset = writeInput(request, view, offset, input);
        }
        if (spec.kind === 'layered-color') {
            const color = spec.foregroundColor ?? [
                0,
                0,
                0,
            ];
            offset = writeU32(view, offset, boundedU32OrDefault(color[0], 0));
            offset = writeU32(view, offset, boundedU32OrDefault(color[1], 0));
            offset = writeU32(view, offset, boundedU32OrDefault(color[2], 0));
        }
    }

    return request;
}

function buildWasmRequest(
    inputs: IBrowserPdfCombineInput[],
    options?: IBrowserPdfCombineWasmImagePreprocessing,
) {
    const pageSpecs = resolveRequestPageSpecs(inputs, options);
    if (pageSpecs) {
        return buildV3WasmRequest(pageSpecs, options);
    }
    return buildV1WasmRequest(inputs);
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

function readWasmFailure(resultCode: number, exports: IPdfImageCombineWasmExports) {
    const encodedError = readWasmError(exports);
    const error = decodeSerializableErrorEnvelope(
        encodedError,
        isNativeErrorEnvelope,
        {allowBareJsonString: true},
    ) ?? {
        code: 'native-failure' as const,
        message: encodedError ?? `Image combine WASM failed with result code ${resultCode}`,
    };
    BrowserLogger.warn('browser-wasm', 'PDF image combine WASM failed; falling back to pdf-lib', {
        error: error.message,
        resultCode,
    });
    return error;
}

const PDF_IMAGE_COMBINE_WASM_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const PDF_IMAGE_COMBINE_WASM_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export async function tryCombineImageInputsWithWasm(
    inputs: IBrowserPdfCombineInput[],
    options?: IBrowserPdfCombineWasmImagePreprocessing,
): Promise<TBrowserPdfCombineWasmOutcome> {
    if (!canUsePdfImageCombineWasm(inputs, options)) {
        return {status: 'unsupported'};
    }

    const exports = await loadPdfImageCombineWasm();
    if (!exports) {
        return {status: 'unavailable'};
    }

    let pointer: number | null = null;
    let requestLength = 0;
    try {
        const request = buildWasmRequest(inputs, options);
        requestLength = request.byteLength;
        if (requestLength === 0 || requestLength > PDF_IMAGE_COMBINE_WASM_MAX_REQUEST_BYTES) {
            return {
                status: 'fatal',
                error: {
                    code: 'too-large',
                    message: 'Image combine WASM request exceeds the admission ceiling',
                },
            };
        }
        pointer = exports.evb_pdf_image_combine_alloc(requestLength);
        if (pointer === 0) {
            pointer = null;
            return {
                status: 'fatal',
                error: {
                    code: 'too-large',
                    message: 'Image combine WASM could not allocate request memory',
                },
            };
        }
        new Uint8Array(exports.memory.buffer, pointer, requestLength).set(request);
        const resultCode = exports.evb_pdf_image_combine_build_pdf(pointer, requestLength);
        if (resultCode !== 0) {
            return {
                status: 'fatal',
                error: readWasmFailure(resultCode, exports),
            };
        }

        const outputPointer = exports.evb_pdf_image_combine_output_ptr();
        const outputLen = exports.evb_pdf_image_combine_output_len();
        if (outputLen === 0 || outputLen > PDF_IMAGE_COMBINE_WASM_MAX_OUTPUT_BYTES) {
            return {
                status: 'fatal',
                error: {
                    code: outputLen > PDF_IMAGE_COMBINE_WASM_MAX_OUTPUT_BYTES
                        ? 'too-large'
                        : 'invalid-request',
                    message: 'Image combine WASM returned an invalid output envelope',
                },
            };
        }

        return {
            status: 'success',
            data: toTransferableUint8Array(copyWasmBytes(exports, outputPointer, outputLen)),
        };
    } catch (error) {
        return {
            status: 'fatal',
            error: {
                code: 'native-failure',
                message: error instanceof Error ? error.message : String(error),
            },
        };
    } finally {
        if (pointer !== null) {
            exports.evb_pdf_image_combine_free(pointer, requestLength);
        }
    }
}
