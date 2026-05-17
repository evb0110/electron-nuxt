import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';

export interface IPdfLiveAnnotationChangeSummary {
    ids: Set<string>;
    hasChanges: boolean;
    hasUnknownChanges: boolean;
}

function getExistingPdfAnnotationIdFromStorageValue(value: unknown) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    for (const property of [
        'annotationElementId',
        'annotationId',
        'id',
        'parentId',
    ]) {
        const candidate = (value as Record<string, unknown>)[property];
        if (typeof candidate !== 'string') {
            continue;
        }
        if (parsePdfJsAnnotationRef(candidate)) {
            return normalizePdfJsAnnotationId(candidate);
        }
    }

    return null;
}

function isDeletedEditorOnlyStorageValue(value: unknown) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    return (value as Record<string, unknown>).deleted === true
        && !getExistingPdfAnnotationIdFromStorageValue(value);
}

function resetCachedModifiedIds(storage: unknown) {
    if (!storage || typeof storage !== 'object') {
        return;
    }

    const resetModifiedIds = (storage as { resetModifiedIds?: unknown }).resetModifiedIds;
    if (typeof resetModifiedIds === 'function') {
        resetModifiedIds.call(storage);
    }
}

export function collectLivePdfJsAnnotationChangeIds(
    document: PDFDocumentProxy | null | undefined,
): IPdfLiveAnnotationChangeSummary {
    if (!document) {
        return {
            ids: new Set<string>(),
            hasChanges: false,
            hasUnknownChanges: false,
        };
    }

    try {
        const storage = document.annotationStorage;
        resetCachedModifiedIds(storage);
        const ids = new Set<string>();
        const serializableRuntimeIdsMappedToPdfRefs = new Set<string>();
        const deletedEditorOnlyRuntimeIds = new Set<string>();
        const serializableMap = storage?.serializable?.map;
        let hasSerializableChanges = false;

        if (serializableMap instanceof Map && serializableMap.size > 0) {
            serializableMap.forEach((value: unknown, key: unknown) => {
                const keyId = normalizePdfJsAnnotationId(typeof key === 'string' ? key : String(key));
                if (isDeletedEditorOnlyStorageValue(value)) {
                    if (keyId) {
                        deletedEditorOnlyRuntimeIds.add(keyId);
                    }
                    return;
                }

                hasSerializableChanges = true;
                const existingPdfAnnotationId = getExistingPdfAnnotationIdFromStorageValue(value);
                if (existingPdfAnnotationId) {
                    ids.add(existingPdfAnnotationId);
                    if (keyId) {
                        serializableRuntimeIdsMappedToPdfRefs.add(keyId);
                    }
                    return;
                }

                if (keyId) {
                    ids.add(keyId);
                }
            });
        }

        const modifiedIds = storage?.modifiedIds?.ids;
        if (typeof modifiedIds?.size === 'number' && modifiedIds.size > 0) {
            modifiedIds.forEach((id: unknown) => {
                const normalized = normalizePdfJsAnnotationId(typeof id === 'string' ? id : String(id));
                if (
                    normalized
                    && !serializableRuntimeIdsMappedToPdfRefs.has(normalized)
                    && !deletedEditorOnlyRuntimeIds.has(normalized)
                ) {
                    ids.add(normalized);
                }
            });
        }

        return {
            ids,
            hasChanges: ids.size > 0 || hasSerializableChanges,
            hasUnknownChanges: ids.size === 0 && hasSerializableChanges,
        };
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect live PDF.js annotation dirty state', error);
        return {
            ids: new Set<string>(),
            hasChanges: true,
            hasUnknownChanges: true,
        };
    }
}
