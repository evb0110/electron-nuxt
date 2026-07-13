import {randomUUID} from 'node:crypto';
import {
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import {parseOcrIndexV3Manifest} from '@contracts/ocrIndex';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import {
    loadSearchIndex,
    SEARCH_INDEX_SCHEMA_VERSION,
} from '@electron/search/indexBuilder';
import {stringifyLegacyJsonSearchIndex} from '@electron/search/stringifyLegacyJsonSearchIndex';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {isAbortError} from '@electron/utils/abort';


interface IPageIdentitySidecar {
    version: 1;
    documentRevisionToken: string;
    pageIds: string[];
}

const logger = createLogger('page-identity');
interface IPageIdentityInitializationTask {
    abortController?: AbortController;
    promise?: Promise<string[]>;
    revision: IDocumentRevisionInfo;
    sourcePath?: string;
}

const initializationTasks = new Map<string, IPageIdentityInitializationTask>();

function sidecarPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-pages.json`;
}

async function writeJsonAtomic(path: string, value: unknown) {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(value), 'utf8');
    await rename(tempPath, path);
}

async function readPageIds(workingCopyPath: string, pageCount: number) {
    const value: unknown = await readFile(sidecarPath(workingCopyPath), 'utf8')
        .then(raw => JSON.parse(raw) as unknown)
        .catch(() => null);
    const pageIds = isRecord(value) ? value.pageIds : null;
    if (
        Array.isArray(pageIds)
        && pageIds.length === pageCount
        && pageIds.every((id): id is string => typeof id === 'string' && id.length > 0)
    ) {
        return [...pageIds];
    }
    return Array.from({length: pageCount}, () => randomUUID());
}

/** Creates the durable identity ledger before the first structural mutation. */
async function initializePageIdentityStore(
    workingCopyPath: string,
    revision: IDocumentRevisionInfo,
    sourcePath?: string,
    shouldPublish: () => boolean = () => true,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    const pageCount = await getPdfPageCount(workingCopyPath, signal ? {signal} : {});
    signal?.throwIfAborted();
    const pageIds = sourcePath
        ? await readPageIds(sourcePath, pageCount)
        : Array.from({length: pageCount}, () => randomUUID());
    signal?.throwIfAborted();
    if (shouldPublish()) {
        await writeJsonAtomic(sidecarPath(workingCopyPath), {
            version: 1,
            documentRevisionToken: revision.token,
            pageIds,
        } satisfies IPageIdentitySidecar);
    }
    return pageIds;
}

/**
 * Registers the inputs needed for page-ledger discovery without starting qpdf.
 * Opening a document is read-only, so page identities are not needed until the
 * first structural mutation. Keeping this task cold prevents repeated opens
 * from stacking page-count subprocesses behind the user-visible open path.
 */
export function schedulePageIdentityStoreInitialization(
    workingCopyPath: string,
    revision: IDocumentRevisionInfo,
    sourcePath?: string,
) {
    const existing = initializationTasks.get(workingCopyPath);
    if (existing) {
        return;
    }
    initializationTasks.set(workingCopyPath, {
        revision,
        ...(sourcePath ? {sourcePath} : {}),
    });
}

/** Starts and joins the ledger task before any revision-changing mutation. */
export async function awaitPageIdentityStoreInitialization(workingCopyPath: string) {
    const entry = initializationTasks.get(workingCopyPath);
    if (!entry) {
        return;
    }
    if (!entry.promise) {
        const startedAt = performance.now();
        const abortController = new AbortController();
        entry.abortController = abortController;
        entry.promise = initializePageIdentityStore(
            workingCopyPath,
            entry.revision,
            entry.sourcePath,
            () => !abortController.signal.aborted && initializationTasks.get(workingCopyPath) === entry,
            abortController.signal,
        );
        void entry.promise.then(
            pageIds => logger.debug(`Page identity initialization complete: ${JSON.stringify({
                durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
                pageCount: pageIds.length,
                workingCopyPath,
            })}`),
            error => {
                if (!isAbortError(error)) {
                    logger.warn(`Page identity initialization failed for "${workingCopyPath}": ${getErrorMessage(error)}`);
                }
            },
        );
    }
    await entry.promise;
}

export function forgetPageIdentityStoreInitialization(workingCopyPath: string) {
    const entry = initializationTasks.get(workingCopyPath);
    entry?.abortController?.abort();
    initializationTasks.delete(workingCopyPath);
}

export function clearPageIdentityStoreInitializations() {
    for (const entry of initializationTasks.values()) {
        entry.abortController?.abort();
    }
    initializationTasks.clear();
}

export function createIdentityDelta(pageCount: number): IPageIdentityDelta {
    return {
        previousPageCount: pageCount,
        pages: Array.from({length: pageCount}, (_value, index) => ({fromPageNumber: index + 1})),
    };
}

export function createDeleteIdentityDelta(pageCount: number, deletedPages: readonly number[]): IPageIdentityDelta {
    const deleted = new Set(deletedPages);
    return {
        previousPageCount: pageCount,
        pages: Array.from({length: pageCount}, (_value, index) => index + 1)
            .filter(pageNumber => !deleted.has(pageNumber))
            .map(fromPageNumber => ({fromPageNumber})),
    };
}

export function createReorderIdentityDelta(pageCount: number, order: readonly number[]): IPageIdentityDelta {
    return {
        previousPageCount: pageCount,
        pages: order.map(fromPageNumber => ({fromPageNumber})),
    };
}

export function createInsertIdentityDelta(
    pageCount: number,
    afterPage: number,
    insertedPageCount: number,
): IPageIdentityDelta {
    const before = Array.from({length: afterPage}, (_value, index) => ({fromPageNumber: index + 1}));
    const inserted = Array.from({length: insertedPageCount}, () => ({insertedId: randomUUID()}));
    const after = Array.from({length: pageCount - afterPage}, (_value, index) => ({fromPageNumber: afterPage + index + 1}));
    return {
        previousPageCount: pageCount,
        pages: [
            ...before,
            ...inserted,
            ...after,
        ],
    };
}

/** Publishes durable page IDs and remaps the OCR catalog through the same delta. */
export async function commitPageIdentityDelta(
    workingCopyPath: string,
    delta: IPageIdentityDelta,
    nextRevision: IDocumentRevisionInfo,
) {
    const priorIds = await readPageIds(workingCopyPath, delta.previousPageCount);
    const mappedPageIds = delta.pages.map(page => (
        'insertedId' in page ? page.insertedId : priorIds[page.fromPageNumber - 1]
    ));
    if (mappedPageIds.some(id => !id) || new Set(mappedPageIds).size !== mappedPageIds.length) {
        throw new Error('Page identity delta is not a one-to-one mapping');
    }
    const pageIds = mappedPageIds.filter((id): id is string => typeof id === 'string');
    await remapOcrCatalog(workingCopyPath, delta, nextRevision);
    await remapSearchIndexes(workingCopyPath, delta, nextRevision);
    const sidecar: IPageIdentitySidecar = {
        version: 1,
        documentRevisionToken: nextRevision.token,
        pageIds,
    };
    await writeJsonAtomic(sidecarPath(workingCopyPath), sidecar);
}

async function remapSearchIndexes(
    workingCopyPath: string,
    delta: IPageIdentityDelta,
    nextRevision: IDocumentRevisionInfo,
) {
    const previousRevision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (!previousRevision) {
        return;
    }
    const [
        legacy,
        compact,
    ] = await Promise.all([
        loadSearchIndex(workingCopyPath, previousRevision.token),
        loadCompactSearchIndex(workingCopyPath, {documentRevision: previousRevision.token}),
    ]);
    const remapPages = <T extends {pageNumber: number}>(pages: readonly T[]) => {
        const pagesByNumber = new Map(pages.map(page => [
            page.pageNumber,
            page,
        ]));
        return delta.pages.flatMap((identity, index): T[] => {
            if (!('fromPageNumber' in identity)) {
                return [];
            }
            const page = pagesByNumber.get(identity.fromPageNumber);
            return page
                ? [{
                    ...page,
                    pageNumber: index + 1,
                }]
                : [];
        });
    };
    await Promise.all([
        legacy
            ? (async () => {
                const indexPath = `${workingCopyPath}.index.json`;
                const tempPath = makeSiblingTempPath(indexPath);
                try {
                    await writeFile(tempPath, stringifyLegacyJsonSearchIndex({
                        ...legacy,
                        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
                        documentRevision: {token: nextRevision.token},
                        createdAt: Date.now(),
                        pageCount: delta.pages.length,
                        pages: remapPages(legacy.pages),
                    }), 'utf8');
                    await atomicReplace(tempPath, indexPath);
                } finally {
                    await rm(tempPath, {force: true});
                }
            })()
            : Promise.resolve(),
        compact
            ? persistCompactSearchIndex(workingCopyPath, {
                documentRevision: nextRevision.token,
                pageCount: delta.pages.length,
                pages: remapPages(compact.pages),
                textSource: compact.textSource,
            })
            : Promise.resolve(),
    ]);
}

async function remapOcrCatalog(
    workingCopyPath: string,
    delta: IPageIdentityDelta,
    nextRevision: IDocumentRevisionInfo,
) {
    const ocrDir = `${workingCopyPath}.ocr`;
    const manifest = await readFile(join(ocrDir, 'manifest.json'), 'utf8')
        .then(raw => parseOcrIndexV3Manifest(JSON.parse(raw), 'strict'))
        .catch(() => null);
    if (!manifest) {
        return;
    }
    const pages = new Map<number, unknown>();
    for (const [
        rawPageNumber,
        mapping,
    ] of Object.entries(manifest.pages)) {
        const pageNumber = Number(rawPageNumber);
        const page = await readFile(join(ocrDir, mapping.path), 'utf8')
            .then(raw => JSON.parse(raw) as unknown)
            .catch(() => null);
        if (page) pages.set(pageNumber, page);
    }
    const replacement = `${ocrDir}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(replacement, {recursive: true});
    const mappings: Record<number, {path: string}> = {};
    for (const [
        index,
        identity,
    ] of delta.pages.entries()) {
        if (!('fromPageNumber' in identity)) continue;
        const page = pages.get(identity.fromPageNumber);
        if (!page) continue;
        const pageNumber = index + 1;
        const path = `page-${String(pageNumber).padStart(4, '0')}.json`;
        await writeFile(join(replacement, path), JSON.stringify({
            ...(page as Record<string, unknown>),
            pageNumber,
            documentRevision: {token: nextRevision.token},
        }), 'utf8');
        mappings[pageNumber] = {path};
    }
    await writeFile(join(replacement, 'manifest.json'), JSON.stringify({
        ...manifest,
        documentRevision: {token: nextRevision.token},
        pageCount: delta.pages.length,
        pages: mappings,
    }), 'utf8');
    const backup = `${ocrDir}.${process.pid}.${randomUUID()}.bak`;
    await rename(ocrDir, backup);
    await rename(replacement, ocrDir);
    await rm(backup, {
        recursive: true,
        force: true,
    });
}
