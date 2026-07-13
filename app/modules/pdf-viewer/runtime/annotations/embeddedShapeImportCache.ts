import type { IShapeAnnotation } from '@app/types/annotations';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

const MAX_COMPLETED_EMBEDDED_SHAPE_IMPORTS = 8;

interface IEmbeddedShapeImportSource {
    data: Uint8Array | null;
    path: string | null;
    documentRevisionToken: TDocumentRevisionToken | null;
    stableSourceIdentity?: string | null;
}

interface IEmbeddedShapeImportCacheEntry {
    controller: AbortController;
    promise: Promise<readonly IShapeAnnotation[]>;
    result: readonly IShapeAnnotation[] | null;
    subscribers: Set<symbol>;
    lastAccess: number;
}

const byteSourceIds = new WeakMap<Uint8Array, number>();
const entries = new Map<string, IEmbeddedShapeImportCacheEntry>();
let nextByteSourceId = 0;
let nextAccess = 0;

function getByteSourceId(data: Uint8Array) {
    const existing = byteSourceIds.get(data);
    if (existing !== undefined) {
        return existing;
    }
    const id = ++nextByteSourceId;
    byteSourceIds.set(data, id);
    return id;
}

function cloneShapes(shapes: readonly IShapeAnnotation[]) {
    return structuredClone(shapes) as IShapeAnnotation[];
}

function createAbortError(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Embedded PDF shape import subscription aborted', 'AbortError');
}

function evictCompletedEntries() {
    const completed = Array.from(entries.entries())
        .filter(([
            ,
            entry,
        ]) => entry.result !== null)
        .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
    while (completed.length > MAX_COMPLETED_EMBEDDED_SHAPE_IMPORTS) {
        const candidate = completed.shift();
        if (candidate) {
            entries.delete(candidate[0]);
        }
    }
}

export function createEmbeddedShapeImportCacheKey(source: IEmbeddedShapeImportSource) {
    if (source.stableSourceIdentity) {
        return JSON.stringify([
            'stable-source',
            source.stableSourceIdentity,
        ]);
    }
    const sourceIdentity = source.path !== null
        ? source.data !== null
            ? `path:${source.path}:bytes:${getByteSourceId(source.data)}`
            : `path:${source.path}`
        : source.data !== null
            ? `bytes:${getByteSourceId(source.data)}`
            : 'empty';
    if (source.documentRevisionToken !== null) {
        return JSON.stringify([
            'revision',
            source.documentRevisionToken,
            source.path === null ? 'inline' : `path:${source.path}`,
        ]);
    }
    return JSON.stringify([
        'source',
        sourceIdentity,
    ]);
}

export function acquireEmbeddedShapeImport(
    key: string,
    loader: (signal: AbortSignal) => Promise<IShapeAnnotation[]>,
    subscriberSignal: AbortSignal,
) {
    subscriberSignal.throwIfAborted();
    let entry = entries.get(key);
    if (!entry) {
        const controller = new AbortController();
        const created: IEmbeddedShapeImportCacheEntry = {
            controller,
            promise: Promise.resolve([]),
            result: null,
            subscribers: new Set(),
            lastAccess: ++nextAccess,
        };
        created.promise = loader(controller.signal)
            .then((shapes) => {
                created.result = cloneShapes(shapes);
                created.lastAccess = ++nextAccess;
                evictCompletedEntries();
                return created.result;
            })
            .catch((error: unknown) => {
                if (entries.get(key) === created) {
                    entries.delete(key);
                }
                throw error;
            });
        entries.set(key, created);
        entry = created;
    }

    entry.lastAccess = ++nextAccess;
    const subscriber = Symbol(key);
    entry.subscribers.add(subscriber);

    return new Promise<IShapeAnnotation[]>((resolve, reject) => {
        let settled = false;
        const release = () => {
            if (settled) {
                return;
            }
            settled = true;
            subscriberSignal.removeEventListener('abort', abort);
            entry.subscribers.delete(subscriber);
        };
        const abort = () => {
            release();
            if (
                entry.result === null
                && entry.subscribers.size === 0
            ) {
                if (entries.get(key) === entry) {
                    entries.delete(key);
                }
                entry.controller.abort(createAbortError(subscriberSignal));
            }
            reject(createAbortError(subscriberSignal));
        };

        subscriberSignal.addEventListener('abort', abort, {once: true});
        entry.promise.then(
            (shapes) => {
                if (settled) {
                    return;
                }
                release();
                resolve(cloneShapes(shapes));
            },
            (error: unknown) => {
                if (settled) {
                    return;
                }
                release();
                reject(error);
            },
        );
    });
}

export function invalidateEmbeddedShapeImportCache() {
    entries.forEach(entry => entry.controller.abort());
    entries.clear();
}

export function getEmbeddedShapeImportCacheSnapshot() {
    return {
        entryCount: entries.size,
        completedEntryCount: Array.from(entries.values()).filter(entry => entry.result !== null).length,
        inFlightEntryCount: Array.from(entries.values()).filter(entry => entry.result === null).length,
    };
}
