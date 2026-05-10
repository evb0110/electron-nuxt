import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdf-annotation-refs';
import { BrowserLogger } from '@app/utils/browser-logger';

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
        const ids = new Set<string>();
        const serializableRuntimeIdsMappedToPdfRefs = new Set<string>();
        const serializableMap = storage?.serializable?.map;

        if (serializableMap instanceof Map && serializableMap.size > 0) {
            serializableMap.forEach((value: unknown, key: unknown) => {
                const keyId = normalizePdfJsAnnotationId(typeof key === 'string' ? key : String(key));
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
                if (normalized && !serializableRuntimeIdsMappedToPdfRefs.has(normalized)) {
                    ids.add(normalized);
                }
            });
        }

        return {
            ids,
            hasChanges: ids.size > 0 || (serializableMap instanceof Map && serializableMap.size > 0),
            hasUnknownChanges: ids.size === 0 && serializableMap instanceof Map && serializableMap.size > 0,
        };
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect live PDF.js annotation dirty state', error);
        return {
            ids: new Set<string>(),
            hasChanges: false,
            hasUnknownChanges: false,
        };
    }
}
