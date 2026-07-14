import type { IDjvuPageSize } from '@contracts/electronApiDjvu';

const DJVU_SCRIPT_PATH = '/vendor/djvujs/djvu.js';

export type { IDjvuPageSize } from '@contracts/electronApiDjvu';

interface IDjvuWorkerTask<T> { run(): Promise<T>; }

export interface IDjvuImageData {
    width: number;
    height: number;
    buffer: ArrayBuffer;
}

interface IDjvuPageTask {
    createPngObjectUrl(): IDjvuWorkerTask<IDjvuPngObjectData>;
    getImageData(rotate?: boolean): IDjvuWorkerTask<IDjvuImageData>;
    getText(): IDjvuWorkerTask<string>;
    getNormalizedTextZones(): IDjvuWorkerTask<IDjvuNormalizedTextZone[] | null>;
}

export interface IDjvuNormalizedTextZone {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
}

export interface IDjvuContentsItem {
    description: string;
    url: string;
    children?: IDjvuContentsItem[];
}

interface IDjvuPngObjectData {
    url: string;
    byteLength: number;
    width: number;
    height: number;
    dpi: number;
}

export interface IDjvuWorker {
    readonly doc: {
        getPagesSizes(): IDjvuWorkerTask<IDjvuPageSize[]>;
        getContents(): IDjvuWorkerTask<IDjvuContentsItem[] | null>;
        getPageNumberByUrl(url: string): IDjvuWorkerTask<number | null>;
        getPage(pageNumber: number): IDjvuPageTask;
    };
    createDocument(
        buffer: ArrayBuffer,
        options?: Record<string, unknown>,
    ): Promise<void>;
    terminate(): void;
    revokeObjectURL(url: string): void;
}

interface IDjvuGlobal { Worker: new (path?: string) => IDjvuWorker; }

type TDjvuWindow = Window & { DjVu?: IDjvuGlobal };

let djvuLoadPromise: Promise<IDjvuGlobal> | null = null;

function getLoadedDjvuGlobal() {
    if (typeof window === 'undefined') {
        return null;
    }

    return (window as TDjvuWindow).DjVu ?? null;
}

export async function loadDjvuJs() {
    const loadedGlobal = getLoadedDjvuGlobal();
    if (loadedGlobal) {
        return loadedGlobal;
    }

    if (typeof document === 'undefined') {
        throw new Error('DjVu.js can only be loaded in a browser runtime');
    }

    djvuLoadPromise ??= new Promise<IDjvuGlobal>((resolve, reject) => {
        const existingScript = document.querySelector<HTMLScriptElement>(
            `script[data-djvujs-src="${DJVU_SCRIPT_PATH}"]`,
        );

        const handleReady = () => {
            const nextGlobal = getLoadedDjvuGlobal();
            if (!nextGlobal) {
                reject(new Error('DjVu.js loaded without exposing window.DjVu'));
                return;
            }

            if (existingScript) {
                existingScript.dataset.djvujsReady = 'true';
            }
            resolve(nextGlobal);
        };

        if (existingScript) {
            if (existingScript.dataset.djvujsReady === 'true') {
                handleReady();
                return;
            }
            existingScript.addEventListener('load', handleReady, { once: true });
            existingScript.addEventListener(
                'error',
                () => reject(new Error(`Failed to load DjVu.js from ${DJVU_SCRIPT_PATH}`)),
                { once: true },
            );
            return;
        }

        const script = document.createElement('script');
        script.src = DJVU_SCRIPT_PATH;
        script.async = true;
        script.dataset.djvujsSrc = DJVU_SCRIPT_PATH;
        script.addEventListener('load', () => {
            script.dataset.djvujsReady = 'true';
            handleReady();
        }, { once: true });
        script.addEventListener(
            'error',
            () => reject(new Error(`Failed to load DjVu.js from ${DJVU_SCRIPT_PATH}`)),
            { once: true },
        );
        document.head.append(script);
    }).catch((error: unknown) => {
        djvuLoadPromise = null;
        throw error;
    });

    return djvuLoadPromise;
}
