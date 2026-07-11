import type {
    IDocumentAnnotationProvider,
    IDocumentAnnotationRecord,
} from '@app/utils/document-viewer/source/documentPageSource';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';

const SIDECAR_STORAGE_VERSION = 1;

function createStorageKey(documentRef: string) {
    let hash = 2166136261;
    for (const character of documentRef) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }
    return `evb:document-annotation-sidecar:v1:${(hash >>> 0).toString(36)}`;
}

function isAnnotationRecord(value: unknown): value is IDocumentAnnotationRecord {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<IDocumentAnnotationRecord>;
    return typeof candidate.id === 'string'
        && Number.isInteger(candidate.pageNumber)
        && (candidate.pageNumber ?? 0) > 0
        && Boolean(candidate.payload)
        && typeof candidate.payload === 'object'
        && !Array.isArray(candidate.payload);
}

function readPersistedAnnotations(storageKey: string) {
    const raw = safeGetLocalStorageItem(storageKey);
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as {
            version?: unknown;
            annotations?: unknown
        };
        return parsed.version === SIDECAR_STORAGE_VERSION && Array.isArray(parsed.annotations)
            ? parsed.annotations.filter(isAnnotationRecord)
            : [];
    } catch {
        return [];
    }
}

/** App-owned overlay data; it never mutates the original DjVu source. */
export function createDocumentAnnotationSidecar(documentRef: string): IDocumentAnnotationProvider {
    const storageKey = createStorageKey(documentRef);
    const annotations = new Map(
        readPersistedAnnotations(storageKey).map(annotation => [
            annotation.id,
            annotation,
        ]),
    );
    const persist = () => safeSetLocalStorageItem(storageKey, JSON.stringify({
        version: SIDECAR_STORAGE_VERSION,
        annotations: [...annotations.values()],
    }));
    return {
        getPageAnnotations(pageNumber) {
            return [...annotations.values()].filter(annotation => annotation.pageNumber === pageNumber);
        },
        upsert(annotation) {
            annotations.set(annotation.id, {
                ...annotation,
                payload: {...annotation.payload},
            });
            persist();
        },
        remove(annotationId) {
            const removed = annotations.delete(annotationId);
            if (removed) persist();
            return removed;
        },
    };
}
