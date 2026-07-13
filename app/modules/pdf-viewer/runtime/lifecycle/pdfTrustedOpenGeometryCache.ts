const STORAGE_KEY = 'evb:pdf-trusted-open-geometry:v1';
const MAX_ENTRIES = 24;
const validatedEntries = new Map<string, IPdfTrustedOpenGeometry>();
const validationTasks = new Map<string, Promise<IPdfTrustedOpenGeometry | null>>();

export interface IPdfTrustedOpenGeometry {
    documentId: string;
    size: number;
    modifiedAt: number;
    pageNumber: number;
    pageCount: number;
    width: number;
    height: number;
    rotation: number;
    savedAt: number;
}

function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function decode(value: unknown): IPdfTrustedOpenGeometry | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Partial<IPdfTrustedOpenGeometry>;
    if (
        typeof record.documentId !== 'string'
        || !Number.isSafeInteger(record.size) || (record.size ?? -1) < 0
        || !Number.isSafeInteger(record.modifiedAt) || (record.modifiedAt ?? -1) < 0
        || !Number.isSafeInteger(record.pageNumber) || (record.pageNumber ?? 0) < 1
        || !Number.isSafeInteger(record.pageCount) || (record.pageCount ?? 0) < 1
        || !isFinitePositive(record.width)
        || !isFinitePositive(record.height)
        || !Number.isInteger(record.rotation)
        || ![
            0,
            90,
            180,
            270,
        ].includes(record.rotation ?? -1)
        || !Number.isSafeInteger(record.savedAt)
    ) {
        return null;
    }
    return record as IPdfTrustedOpenGeometry;
}

function readAll(): IPdfTrustedOpenGeometry[] {
    if (typeof localStorage === 'undefined') {
        return [];
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
        return Array.isArray(parsed) ? parsed.map(decode).filter(value => value !== null) : [];
    } catch {
        return [];
    }
}

function buildEntryKey(documentId: string, pageNumber: number) {
    return `${documentId}\u0000${String(pageNumber)}`;
}

export function rememberValidatedTrustedPdfOpenGeometry(entry: IPdfTrustedOpenGeometry) {
    if (decode(entry) === null) {
        return false;
    }
    const key = buildEntryKey(entry.documentId, entry.pageNumber);
    validatedEntries.delete(key);
    validatedEntries.set(key, Object.freeze({...entry}));
    while (validatedEntries.size > MAX_ENTRIES) {
        const oldestKey = validatedEntries.keys().next().value;
        if (typeof oldestKey !== 'string') {
            break;
        }
        validatedEntries.delete(oldestKey);
    }
    return true;
}

export function readPrevalidatedTrustedPdfOpenGeometry(documentId: string, pageNumber: number) {
    return validatedEntries.get(buildEntryKey(documentId, pageNumber)) ?? null;
}

function forgetPrevalidatedTrustedPdfOpenGeometry(documentId: string, pageNumber: number) {
    validatedEntries.delete(buildEntryKey(documentId, pageNumber));
}

export function prevalidateTrustedPdfOpenGeometry(
    documentId: string,
    pageNumber: number,
    readStat: (() => Promise<{
        size: number;
        modifiedAt?: number;
    }>) | undefined,
    readOpeningGeometry?: () => Promise<{
        pageNumber: number;
        pageCount: number;
        width: number;
        height: number;
        rotation: number;
        size: number;
        modifiedAt: number;
    }>,
    options: {forceAuthoritativeRefresh?: boolean} = {},
) {
    const validated = readPrevalidatedTrustedPdfOpenGeometry(documentId, pageNumber);
    if (validated && !options.forceAuthoritativeRefresh) {
        return Promise.resolve(validated);
    }
    const unvalidated = peekTrustedPdfOpenGeometry(documentId, pageNumber);
    if (!unvalidated && !readOpeningGeometry) {
        return Promise.resolve(null);
    }
    const key = buildEntryKey(documentId, pageNumber);
    const existingTask = validationTasks.get(key);
    if (existingTask) {
        return existingTask;
    }
    const task = (async () => {
        if (unvalidated && !readOpeningGeometry && readStat) {
            try {
                const stat = await readStat();
                const current = readTrustedPdfOpenGeometry(documentId, stat, pageNumber);
                if (current) {
                    rememberValidatedTrustedPdfOpenGeometry(current);
                    return current;
                }
            } catch (error) {
                // A Recent original source is authorized by the fenced opening-
                // geometry capability before its working copy exists, while the
                // generic file-stat capability intentionally accepts only
                // managed readable paths. When authoritative geometry discovery
                // is available, use its source identity instead of letting an
                // old persistent cache entry block the pre-open preparation.
                if (!readOpeningGeometry) {
                    throw error;
                }
            }
        }
        if (unvalidated) invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
        if (!readOpeningGeometry) {
            return null;
        }
        let openingGeometry;
        try {
            openingGeometry = await readOpeningGeometry();
        } catch (error) {
            if (options.forceAuthoritativeRefresh) {
                invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
            }
            throw error;
        }
        const freshEntry: IPdfTrustedOpenGeometry = {
            documentId,
            ...openingGeometry,
            savedAt: Date.now(),
        };
        if (decode(freshEntry) === null || freshEntry.pageNumber !== pageNumber) {
            if (options.forceAuthoritativeRefresh) {
                invalidateTrustedPdfOpenGeometry(documentId, pageNumber);
            }
            return null;
        }
        writeTrustedPdfOpenGeometry(freshEntry);
        rememberValidatedTrustedPdfOpenGeometry(freshEntry);
        return freshEntry;
    })()
        .finally(() => validationTasks.delete(key));
    validationTasks.set(key, task);
    return task;
}

function readTrustedPdfOpenGeometry(
    documentId: string,
    stat: {
        size: number;
        modifiedAt?: number
    },
    pageNumber: number,
) {
    return readAll().find(entry => isTrustedPdfOpenGeometryCurrent(
        entry,
        documentId,
        stat,
        pageNumber,
    )) ?? null;
}

/** Synchronous presence lookup for invalidation only; never render this entry before validation. */
export function peekTrustedPdfOpenGeometry(documentId: string, pageNumber: number) {
    return readAll().find(entry => (
        entry.documentId === documentId
        && entry.pageNumber === pageNumber
    )) ?? null;
}

export function invalidateTrustedPdfOpenGeometry(documentId: string, pageNumber: number) {
    forgetPrevalidatedTrustedPdfOpenGeometry(documentId, pageNumber);
    if (typeof localStorage === 'undefined') {
        return;
    }
    const entries = readAll().filter(entry => (
        entry.documentId !== documentId
        || entry.pageNumber !== pageNumber
    ));
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
        // Cache invalidation remains best-effort under denied storage.
    }
}

export function isTrustedPdfOpenGeometryCurrent(
    entry: IPdfTrustedOpenGeometry,
    documentId: string,
    stat: {
        size: number;
        modifiedAt?: number
    },
    pageNumber = entry.pageNumber,
) {
    if (stat.modifiedAt === undefined) {
        return false;
    }
    return (
        entry.documentId === documentId
        && entry.pageNumber === pageNumber
        && entry.size === stat.size
        && entry.modifiedAt === stat.modifiedAt
    );
}

export function shouldApplyTrustedPdfOpenGeometry(input: {
    lookupGeneration: number;
    currentLookupGeneration: number;
    openSurfaceGeneration: number;
    currentOpenSurfaceGeneration: number;
    source: unknown;
    currentSource: unknown;
    hasPdfDocument: boolean;
    authoritativeMetricCount: number;
}) {
    return input.lookupGeneration === input.currentLookupGeneration
        && input.openSurfaceGeneration === input.currentOpenSurfaceGeneration
        && input.source === input.currentSource
        && !input.hasPdfDocument
        && input.authoritativeMetricCount === 0;
}

export function writeTrustedPdfOpenGeometry(entry: IPdfTrustedOpenGeometry) {
    if (typeof localStorage === 'undefined' || decode(entry) === null) {
        return;
    }
    const entries = readAll().filter(candidate => (
        candidate.documentId !== entry.documentId
        || candidate.pageNumber !== entry.pageNumber
    ));
    entries.unshift(entry);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    } catch {
        // Geometry caching is an optimization. Storage denial cannot affect open.
    }
}
