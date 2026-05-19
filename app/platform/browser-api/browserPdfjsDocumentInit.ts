import type * as PdfJsLibNamespace from 'pdfjs-dist';
import {
    browserDocumentStore,
    BROWSER_DOCUMENT_CHUNK_SIZE,
} from '@app/platform/browserDocumentStore';
import {
    getPdfjsAssetDir,
    getPdfjsWorkerUrl,
} from '@app/utils/viewerAssets';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';

const PDFJS_RANGE_CHUNK_SIZE = Math.max(512 * 1024, BROWSER_DOCUMENT_CHUNK_SIZE);

type TPdfJsLib = typeof PdfJsLibNamespace;
type TPdfJsDocumentInit = Parameters<TPdfJsLib['getDocument']>[0];

let pdfjsLibPromise: Promise<TPdfJsLib> | null = null;

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
                if (!this.aborted) {
                    this.aborted = true;
                    this.onDataRange(begin, null);
                }
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

export {
    createPdfjsDocumentInit,
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
};
