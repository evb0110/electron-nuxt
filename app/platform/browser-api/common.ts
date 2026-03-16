import type * as PdfJsLibNamespace from 'pdfjs-dist';
import type { IMenuEventUnsubscribe } from '@contracts/electron-api';

const SUPPORTED_IMAGE_EXTENSIONS = [
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.svgz',
    '.tif',
    '.tiff',
    '.webp',
    '.ico',
] as const;

const OPEN_IMAGE_ACCEPT = 'image/*';
const OPEN_PDF_ACCEPT = '.pdf,application/pdf';
const OPEN_INPUT_ACCEPT = [
    OPEN_PDF_ACCEPT,
    '.djvu',
    '.djv',
    ...SUPPORTED_IMAGE_EXTENSIONS,
].join(',');

const EXPORT_RENDER_SCALE = 2;
const SEARCH_RESULT_LIMIT = 5000;
const SEARCH_EXCERPT_CONTEXT_CHARS = 30;
const SETTINGS_STORAGE_KEY = 'evb-viewer:browser:settings';

type TPdfJsLib = typeof PdfJsLibNamespace;

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
    return pdfjsLibPromise;
}

function createPdfjsDocumentInit(pdfjsLib: TPdfJsLib, data: Uint8Array) {
    return {
        data,
        disableWorker: true,
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    } as unknown as Parameters<typeof pdfjsLib.getDocument>[0];
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
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    SETTINGS_STORAGE_KEY,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
    createPdfjsDocumentInit,
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
