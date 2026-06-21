import type * as PdfjsLibNamespace from 'pdfjs-dist';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {
    getPdfjsAssetDir,
    getViewerAssetResolver,
} from '@app/utils/viewerAssets';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';

const PDFJS_RANGE_CHUNK_SIZE = Math.max(512 * 1024, BROWSER_DOCUMENT_CHUNK_SIZE);

type TPdfjsLib = typeof PdfjsLibNamespace;
type TPdfjsDocumentInit = Parameters<TPdfjsLib['getDocument']>[0];

let pdfjsLibPromise: Promise<TPdfjsLib> | null = null;

interface ICreateBrowserPdfjsDocumentInitOptions { onRangeReadFailure?: (error: Error) => void; }

async function getPdfjsLib() {
    pdfjsLibPromise ??= import('pdfjs-dist');
    const pdfjsLib = await pdfjsLibPromise;
    const globalWorkerOptions = pdfjsLib.GlobalWorkerOptions as { workerSrc?: string };
    const workerSrc = getViewerAssetResolver().pdfWorkerUrl();

    if (globalWorkerOptions.workerSrc !== workerSrc) {
        globalWorkerOptions.workerSrc = workerSrc;
    }

    return pdfjsLib;
}

function createPdfjsDocumentInit(pdfjsLib: TPdfjsLib, data: Uint8Array) {
    const init = {
        data: toUint8Array(data),
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
        cMapUrl: getPdfjsAssetDir('cmaps'),
        cMapPacked: true,
        wasmUrl: getPdfjsAssetDir('wasm'),
        iccUrl: getPdfjsAssetDir('iccs'),
        useSystemFonts: false,
    } satisfies TPdfjsDocumentInit;
    return init;
}

async function createPdfjsDocumentInitFromBrowserDocument(
    pdfjsLib: TPdfjsLib,
    path: string,
    options: ICreateBrowserPdfjsDocumentInitOptions = {},
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

    class BrowserDocumentRangeTransport extends pdfjsLib.PDFDataRangeTransport {
        private aborted = false;

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
            } catch (error) {
                if (!this.aborted) {
                    this.aborted = true;
                    options.onRangeReadFailure?.(error instanceof Error ? error : new Error(String(error)));
                    this.abort();
                }
            }
        }
    }

    const init = {
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
    } satisfies TPdfjsDocumentInit;
    return init;
}

export {
    createPdfjsDocumentInit,
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
};
