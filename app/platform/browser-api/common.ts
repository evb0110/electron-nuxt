import type * as PdfJsLibNamespace from 'pdfjs-dist';
import type { IMenuEventUnsubscribe } from '@contracts/platform-api';
import {
    browserDocumentStore,
    BROWSER_DOCUMENT_CHUNK_SIZE,
} from '@app/platform/browser-document-store';
import {
    getPdfjsAssetDir,
    getPdfjsWorkerUrl,
} from '@app/utils/viewer-assets';

const SUPPORTED_IMAGE_EXTENSIONS = [
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
    '.ico',
] as const;

const OPEN_IMAGE_ACCEPT = 'image/*';
const OPEN_PDF_ACCEPT = '.pdf,application/pdf';
const OPEN_DJVU_ACCEPT = '.djvu,.djv';
const OPEN_PDF_IMAGE_ACCEPT = [
    OPEN_PDF_ACCEPT,
    ...SUPPORTED_IMAGE_EXTENSIONS,
].join(',');
const OPEN_INPUT_ACCEPT = [
    OPEN_PDF_IMAGE_ACCEPT,
    OPEN_DJVU_ACCEPT,
].join(',');

const EXPORT_RENDER_SCALE = 2;
const SEARCH_RESULT_LIMIT = 5000;
const SEARCH_EXCERPT_CONTEXT_CHARS = 30;
const PDFJS_RANGE_CHUNK_SIZE = Math.max(512 * 1024, BROWSER_DOCUMENT_CHUNK_SIZE);
const SETTINGS_STORAGE_KEY = 'evb-viewer:browser:settings';
const OCR_SETTINGS_STORAGE_KEY = 'evb-viewer:browser:ocr-settings';

type TPdfJsLib = typeof PdfJsLibNamespace;
type TPdfJsDocumentInit = Parameters<TPdfJsLib['getDocument']>[0];

interface IFilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
}

interface IOpenFilePickerOptions {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: IFilePickerAcceptType[];
}

interface ISaveFilePickerOptions {
    suggestedName?: string;
    excludeAcceptAllOption?: boolean;
    types?: IFilePickerAcceptType[];
}

interface IWindowWithBrowserFilePickers extends Window {
    showOpenFilePicker?: (
        options?: IOpenFilePickerOptions,
    ) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (
        options?: ISaveFilePickerOptions,
    ) => Promise<FileSystemFileHandle>;
}

let pdfjsLibPromise: Promise<TPdfJsLib> | null = null;

function noopUnsubscribe(): IMenuEventUnsubscribe {
    return () => {};
}

async function getPdfjsLib() {
    pdfjsLibPromise ??= import('pdfjs-dist');
    const pdfjsLib = await pdfjsLibPromise;
    const globalWorkerOptions = pdfjsLib.GlobalWorkerOptions as { workerSrc?: string };
    const workerSrc = getPdfjsWorkerUrl();

    if (globalWorkerOptions.workerSrc !== workerSrc) {
        globalWorkerOptions.workerSrc = workerSrc;
    }

    return pdfjsLib;
}

function createPdfjsDocumentInit(pdfjsLib: TPdfJsLib, data: Uint8Array) {
    return {
        data: toUint8Array(data),
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
        cMapUrl: getPdfjsAssetDir('cmaps'),
        cMapPacked: true,
        wasmUrl: getPdfjsAssetDir('wasm'),
        iccUrl: getPdfjsAssetDir('iccs'),
        useSystemFonts: false,
    } as unknown as TPdfJsDocumentInit;
}

type TPdfDataRangeTransportConstructor = new (
    length: number,
    initialData: Uint8Array | null,
    progressiveDone?: boolean,
    contentDispositionFilename?: string,
) => {
    length: number;
    onDataRange: (begin: number, chunk: Uint8Array | null) => void;
    onDataProgress: (loaded: number, total?: number) => void;
    requestDataRange: (begin: number, end: number) => void;
    abort: () => void;
};

async function createPdfjsDocumentInitFromBrowserDocument(
    pdfjsLib: TPdfJsLib,
    path: string,
) {
    const { size } = await browserDocumentStore.stat(path);
    const initialData = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(size, PDFJS_RANGE_CHUNK_SIZE),
    );

    if (size <= PDFJS_RANGE_CHUNK_SIZE) {
        return createPdfjsDocumentInit(pdfjsLib, initialData);
    }

    const RangeTransportBase =
        pdfjsLib.PDFDataRangeTransport as unknown as TPdfDataRangeTransportConstructor;

    class BrowserDocumentRangeTransport extends RangeTransportBase {
        private aborted = false;
        private loadedBytes = initialData.byteLength;

        public constructor() {
            super(size, initialData, false);
        }

        public override requestDataRange = (begin: number, end: number) => {
            if (this.aborted || end <= begin) {
                return;
            }

            void this.loadRange(begin, end);
        };

        public override abort = () => {
            this.aborted = true;
        };

        private async loadRange(begin: number, end: number) {
            try {
                const chunk = await browserDocumentStore.readRange(
                    path,
                    begin,
                    Math.max(0, end - begin),
                );
                if (this.aborted) {
                    return;
                }

                this.onDataRange(begin, chunk);
                this.loadedBytes = Math.max(
                    this.loadedBytes,
                    Math.min(this.length, begin + chunk.byteLength),
                );
                this.onDataProgress(this.loadedBytes, this.length);
            } catch {
                this.abort();
            }
        }
    }

    return {
        length: size,
        range: new BrowserDocumentRangeTransport(),
        rangeChunkSize: PDFJS_RANGE_CHUNK_SIZE,
        disableAutoFetch: true,
        disableStream: true,
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
        cMapUrl: getPdfjsAssetDir('cmaps'),
        cMapPacked: true,
        wasmUrl: getPdfjsAssetDir('wasm'),
        iccUrl: getPdfjsAssetDir('iccs'),
        useSystemFonts: false,
    } as unknown as TPdfJsDocumentInit;
}

function toArrayBuffer(data: Uint8Array | ArrayBufferLike) {
    if (data instanceof ArrayBuffer) {
        return data;
    }

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function toUint8Array(data: Uint8Array | ArrayBufferLike) {
    const source = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
}

function getWindowWithPickers() {
    if (typeof window === 'undefined') {
        return null;
    }

    return window as IWindowWithBrowserFilePickers;
}

function getExtension(fileName: string) {
    const lowerName = fileName.toLowerCase();
    const lastDot = lowerName.lastIndexOf('.');
    return lastDot >= 0 ? lowerName.slice(lastDot) : '';
}

function isPdfFileName(fileName: string) {
    return getExtension(fileName) === '.pdf';
}

function isDjvuFileName(fileName: string) {
    const extension = getExtension(fileName);
    return extension === '.djvu' || extension === '.djv';
}

function ensurePdfExtension(fileName: string) {
    return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
}

function ensureDocxExtension(fileName: string) {
    return fileName.toLowerCase().endsWith('.docx')
        ? fileName
        : `${fileName}.docx`;
}

function buildOpenPdfPickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Documents',
        accept: {
            'application/pdf': ['.pdf'],
            'application/octet-stream': [
                '.djvu',
                '.djv',
            ],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
        },
    }];
}

function buildOpenPdfImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Documents',
        accept: {
            'application/pdf': ['.pdf'],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
        },
    }];
}

function buildImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Images',
        accept: { 'image/*': [...SUPPORTED_IMAGE_EXTENSIONS] },
    }];
}

function buildPdfSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'PDF Documents',
        accept: { 'application/pdf': ['.pdf'] },
    }];
}

function buildDocxSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: 'Word Documents',
        accept: {'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          ['.docx']},
    }];
}

export {
    EXPORT_RENDER_SCALE,
    OPEN_PDF_IMAGE_ACCEPT,
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    OCR_SETTINGS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildOpenPdfImagePickerTypes,
    buildPdfSaveTypes,
    createPdfjsDocumentInit,
    createPdfjsDocumentInitFromBrowserDocument,
    ensureDocxExtension,
    ensurePdfExtension,
};

export {
    getExtension,
    getPdfjsLib,
    getWindowWithPickers,
    isDjvuFileName,
    isPdfFileName,
    noopUnsubscribe,
    toArrayBuffer,
    toUint8Array,
};

export type {IFilePickerAcceptType};
