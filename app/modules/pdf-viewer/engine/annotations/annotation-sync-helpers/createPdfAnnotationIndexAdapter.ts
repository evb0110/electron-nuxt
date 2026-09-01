import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexChunk,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {formatPdfJsAnnotationRef} from '@app/utils/pdfAnnotationRefs';
import {isNativeDocumentRef} from '@app/utils/documentRef';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {isDesktopPlatformActive} from '@app/utils/platform';
import {BrowserLogger} from '@app/utils/browserLogger';

interface IPdfAnnotationIndexFiles {
    readPdfAnnotationIndexChunk: (
        sessionId: string,
        offset: number,
        options?: {chunkBytes?: number},
    ) => Promise<IPdfAnnotationIndexChunk>;
    releasePdfAnnotationIndex: (sessionId: string) => Promise<boolean>;
    cancelPdfAnnotationIndex: (sessionId: string) => Promise<{canceled: boolean}>;
}

/**
 * The renderer only needs names for the page it is about to inspect. Keeping
 * the transport details here means the sync bridge does not depend on the
 * Electron contract or on the sidecar representation.
 */
export interface IPdfAnnotationIndexReader {
    // An exhausted index can answer an empty page without crossing an async
    // boundary. This matters for a large PDF with no annotations: the scan
    // still visits every page, but it must not retain one Promise and Map per
    // page until the renderer gets a chance to collect them.
    readPage: (
        pageIndex: number,
    ) => IPdfAnnotationIndexPageRead | Promise<IPdfAnnotationIndexPageRead>;
    readPageNames: (pageIndex: number) => Promise<ReadonlyMap<string, string>>;
    cancel: () => Promise<void>;
    release: () => Promise<void>;
}

/**
 * A native page read distinguishes a proven-empty page from a page that has
 * entries whose names cannot identify a PDF.js annotation.
 */
export interface IPdfAnnotationIndexPageRead {
    hasAnnotations: boolean;
    names: ReadonlyMap<string, string>;
}

export interface IPdfAnnotationIndexAdapter {begin: (revision: TDocumentRevisionToken | null) => Promise<IPdfAnnotationIndexReader>;}

export interface IPdfAnnotationIndexLifecycle {
    add: (reader: IPdfAnnotationIndexReader) => void;
    delete: (reader: IPdfAnnotationIndexReader) => void;
    cancelAll: () => void;
}

export function createPdfAnnotationIndexLifecycle(): IPdfAnnotationIndexLifecycle {
    const activeReaders = new Set<IPdfAnnotationIndexReader>();

    function cancelAll() {
        for (const reader of activeReaders) {
            void reader.cancel().catch((error: unknown) => {
                BrowserLogger.debug(
                    'annotations',
                    'Failed to cancel native PDF annotation index',
                    error,
                );
            });
            void reader.release().catch((error: unknown) => {
                BrowserLogger.debug(
                    'annotations',
                    'Failed to release native PDF annotation index',
                    error,
                );
            });
        }
        activeReaders.clear();
    }

    return {
        add: reader => activeReaders.add(reader),
        delete: reader => activeReaders.delete(reader),
        cancelAll,
    };
}

const RENDERER_ANNOTATION_INDEX_CHUNK_BYTES = PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES;
const EMPTY_ANNOTATION_INDEX_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ANNOTATION_INDEX_PAGE_READ: IPdfAnnotationIndexPageRead = Object.freeze({
    hasAnnotations: false,
    names: EMPTY_ANNOTATION_INDEX_NAMES,
});

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return typeof value === 'object'
        && value !== null
        && typeof (value as {then?: unknown}).then === 'function';
}

function isValidAnnotationIndexEntry(
    entry: IPdfAnnotationIndexEntry,
): entry is IPdfAnnotationIndexEntry & {name: string} {
    return Number.isSafeInteger(entry.pageIndex)
        && entry.pageIndex >= 0
        && Number.isSafeInteger(entry.objectNumber)
        && entry.objectNumber > 0
        && Number.isSafeInteger(entry.generationNumber)
        && entry.generationNumber >= 0
        && typeof entry.name === 'string'
        && entry.name.trim().length > 0;
}

function isValidAnnotationIndexPage(entry: IPdfAnnotationIndexEntry) {
    return Number.isSafeInteger(entry.pageIndex) && entry.pageIndex >= 0;
}

function addChunkEntries(
    pendingNamesByPage: Map<number, Map<string, string>>,
    indexedPages: Set<number>,
    chunk: IPdfAnnotationIndexChunk,
) {
    for (const entry of chunk.entries) {
        if (isValidAnnotationIndexPage(entry)) {
            // A page entry is proof that the page has an annotation even when
            // it is a direct dictionary marker (object number zero) or its
            // annotation has no /NM name.
            indexedPages.add(entry.pageIndex);
        }
        if (!isValidAnnotationIndexEntry(entry)) {
            continue;
        }
        let namesByAnnotationId = pendingNamesByPage.get(entry.pageIndex);
        if (!namesByAnnotationId) {
            namesByAnnotationId = new Map<string, string>();
            pendingNamesByPage.set(entry.pageIndex, namesByAnnotationId);
        }
        namesByAnnotationId.set(
            formatPdfJsAnnotationRef({
                objectNumber: entry.objectNumber,
                generationNumber: entry.generationNumber,
            }),
            entry.name.trim(),
        );
    }
}

function createReader(
    files: IPdfAnnotationIndexFiles,
    session: IPdfAnnotationIndexSession,
): IPdfAnnotationIndexReader {
    const pendingNamesByPage = new Map<number, Map<string, string>>();
    const indexedPages = new Set<number>();
    let nextOffset = 0;
    let done = false;
    let highestIndexedPage = -1;
    let cancelPromise: Promise<void> | null = null;
    let releasePromise: Promise<void> | null = null;

    async function readNextChunk() {
        if (done) {
            return;
        }
        const requestedOffset = nextOffset;
        const chunk = await files.readPdfAnnotationIndexChunk(
            session.sessionId,
            requestedOffset,
            {chunkBytes: RENDERER_ANNOTATION_INDEX_CHUNK_BYTES},
        );
        if (chunk.offset !== requestedOffset) {
            throw new Error(
                `PDF annotation index returned offset ${chunk.offset} for requested offset ${requestedOffset}`,
            );
        }

        const nextChunkOffset = chunk.nextOffset ?? requestedOffset + chunk.byteLength;
        if (
            !Number.isSafeInteger(nextChunkOffset)
            || (nextChunkOffset <= requestedOffset && !chunk.done)
        ) {
            throw new Error('PDF annotation index returned a non-advancing chunk offset');
        }
        nextOffset = nextChunkOffset;
        done = chunk.done;
        for (const entry of chunk.entries) {
            if (isValidAnnotationIndexPage(entry)) {
                highestIndexedPage = Math.max(highestIndexedPage, entry.pageIndex);
            }
        }
        addChunkEntries(pendingNamesByPage, indexedPages, chunk);
    }

    function consumePageRead(pageIndex: number): IPdfAnnotationIndexPageRead {
        const names = pendingNamesByPage.get(pageIndex);
        const hasAnnotations = indexedPages.has(pageIndex);
        pendingNamesByPage.delete(pageIndex);
        indexedPages.delete(pageIndex);
        if (!names && !hasAnnotations) {
            return EMPTY_ANNOTATION_INDEX_PAGE_READ;
        }
        return {
            hasAnnotations,
            names: names ?? EMPTY_ANNOTATION_INDEX_NAMES,
        };
    }

    async function readPageAsync(pageIndex: number): Promise<IPdfAnnotationIndexPageRead> {
        while (
            !done
            && highestIndexedPage <= pageIndex
        ) {
            await readNextChunk();
        }

        return consumePageRead(pageIndex);
    }

    function readPage(pageIndex: number): IPdfAnnotationIndexPageRead | Promise<IPdfAnnotationIndexPageRead> {
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            return EMPTY_ANNOTATION_INDEX_PAGE_READ;
        }
        if (done) {
            return consumePageRead(pageIndex);
        }

        return readPageAsync(pageIndex);
    }

    async function readPageNames(pageIndex: number) {
        const pageRead = readPage(pageIndex);
        return (isPromiseLike(pageRead) ? await pageRead : pageRead).names;
    }

    async function cancel() {
        if (cancelPromise) {
            return cancelPromise;
        }
        cancelPromise = files.cancelPdfAnnotationIndex(session.sessionId).then(() => undefined);
        return cancelPromise;
    }

    async function release() {
        if (releasePromise) {
            return releasePromise;
        }
        releasePromise = (async () => {
            // If a stale scan requested cancellation, release only after that
            // request reaches the host so the session cannot be reused early.
            try {
                await cancelPromise;
            } catch (error: unknown) {
                BrowserLogger.debug(
                    'annotations',
                    'Failed to cancel native PDF annotation index before release',
                    error,
                );
            }
            await files.releasePdfAnnotationIndex(session.sessionId);
            pendingNamesByPage.clear();
            indexedPages.clear();
        })();
        return releasePromise;
    }

    return {
        readPage,
        readPageNames,
        cancel,
        release,
    };
}

/**
 * Return a native reader only for an absolute desktop path with the complete
 * pull API. Browser document refs and incomplete bridges stay on the honest
 * renderer fallback and never reach `doc.getData`.
 */
export function createPdfAnnotationIndexAdapter(
    path: TDocumentRef | null | undefined,
): IPdfAnnotationIndexAdapter | null {
    if (!path || !isNativeDocumentRef(path) || !isDesktopPlatformActive()) {
        return null;
    }

    let files: ReturnType<typeof getDocumentFilesCapability>;
    try {
        files = getDocumentFilesCapability();
    } catch {
        return null;
    }

    const begin = files.beginPdfAnnotationIndex;
    const read = files.readPdfAnnotationIndexChunk;
    const release = files.releasePdfAnnotationIndex;
    const cancel = files.cancelPdfAnnotationIndex;
    if (!begin || !read || !release || !cancel) {
        return null;
    }

    return {begin: async (revision) => {
        const expectedRevision = revision ?? (await files.getDocumentRevision(path)).token;
        const session = await begin(path, {expectedDocumentRevisionToken: expectedRevision});
        return createReader(
            {
                readPdfAnnotationIndexChunk: read,
                releasePdfAnnotationIndex: release,
                cancelPdfAnnotationIndex: cancel,
            },
            session,
        );
    }};
}
