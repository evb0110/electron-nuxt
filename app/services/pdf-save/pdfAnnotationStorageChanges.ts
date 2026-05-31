import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { isRecord } from '@contracts/runtimeGuards';
import { BrowserLogger } from '@app/utils/browserLogger';

export interface IPdfLiveAnnotationChangeSummary {
    ids: Set<string>;
    replayableEditorNoteIds: Set<string>;
    hasChanges: boolean;
    hasUnknownChanges: boolean;
    fingerprint: string;
}

const PDFJS_FREETEXT_ANNOTATION_EDITOR_TYPE = 3;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;
const EMPTY_ANNOTATION_CHANGE_FINGERPRINT = 'empty';

function getExistingPdfAnnotationIdFromStorageValue(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }

    for (const property of [
        'annotationElementId',
        'annotationId',
        'id',
        'parentId',
    ]) {
        const candidate = value[property];
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
    if (!isRecord(value)) {
        return false;
    }

    return value.deleted === true
        && !getExistingPdfAnnotationIdFromStorageValue(value);
}

function isBlankStringValue(value: unknown) {
    return typeof value === 'string'
        && value.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length === 0;
}

function isFreeTextEditorType(value: unknown) {
    if (value === PDFJS_FREETEXT_ANNOTATION_EDITOR_TYPE) {
        return true;
    }
    if (typeof value !== 'string') {
        return false;
    }

    const normalized = value.trim().toLowerCase().replace(/[-_\s]/gu, '');
    return normalized === 'freetext'
        || normalized === 'freetexteditor'
        || normalized === 'typewriter';
}

function isFreeTextEditorStorageValue(value: Record<string, unknown>) {
    return [
        value.annotationType,
        value.annotationEditorType,
        value.editorType,
        value.type,
        value.name,
        value.subtype,
    ].some(isFreeTextEditorType);
}

function hasTextPayload(value: unknown) {
    if (typeof value === 'string') {
        return value.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length > 0;
    }
    if (!isRecord(value) || value.deleted === true) {
        return false;
    }

    for (const property of [
        'contents',
        'text',
        'str',
        'value',
    ]) {
        if (hasTextPayload(value[property])) {
            return true;
        }
    }

    return hasTextPayload(value.contentsObj);
}

function hasActivePopupPayload(value: Record<string, unknown>) {
    const popup = value.popup;
    return isRecord(popup) && popup.deleted !== true;
}

function isReplayableFreeTextNoteStorageValue(value: unknown) {
    if (!isRecord(value) || value.deleted === true) {
        return false;
    }
    if (!isFreeTextEditorStorageValue(value)) {
        return false;
    }

    return (
        hasActivePopupPayload(value)
        || isBlankStringValue(value.value)
        || hasTextPayload(value.comment)
        || value.hasComment === true
    );
}

function normalizeModifiedAnnotationStorageId(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = normalizePdfJsAnnotationId(value);
    if (normalized === 'undefined' || normalized === 'null') {
        return null;
    }
    return normalized;
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
            replayableEditorNoteIds: new Set<string>(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: EMPTY_ANNOTATION_CHANGE_FINGERPRINT,
        };
    }

    try {
        const storage = document.annotationStorage;
        resetCachedModifiedIds(storage);
        const ids = new Set<string>();
        const replayableEditorNoteIds = new Set<string>();
        const serializableRuntimeIdsMappedToPdfRefs = new Set<string>();
        const deletedEditorOnlyRuntimeIds = new Set<string>();
        const serializable = storage?.serializable;
        const serializableMap = serializable?.map;
        const serializableHash = typeof serializable?.hash === 'string'
            ? serializable.hash
            : '';
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
                    if (isReplayableFreeTextNoteStorageValue(value)) {
                        replayableEditorNoteIds.add(existingPdfAnnotationId);
                    }
                    if (keyId) {
                        serializableRuntimeIdsMappedToPdfRefs.add(keyId);
                    }
                    return;
                }

                if (keyId) {
                    ids.add(keyId);
                    if (isReplayableFreeTextNoteStorageValue(value)) {
                        replayableEditorNoteIds.add(keyId);
                    }
                }
            });
        }

        const modifiedIds = storage?.modifiedIds?.ids;
        if (typeof modifiedIds?.size === 'number' && modifiedIds.size > 0) {
            modifiedIds.forEach((id: unknown) => {
                const normalized = normalizeModifiedAnnotationStorageId(id);
                if (
                    normalized
                    && !serializableRuntimeIdsMappedToPdfRefs.has(normalized)
                    && !deletedEditorOnlyRuntimeIds.has(normalized)
                ) {
                    ids.add(normalized);
                }
            });
        }

        const hasChanges = ids.size > 0 || hasSerializableChanges;
        const fingerprint = hasChanges
            ? JSON.stringify({
                hash: serializableHash,
                ids: [...ids].sort(),
                serializable: hasSerializableChanges,
            })
            : EMPTY_ANNOTATION_CHANGE_FINGERPRINT;

        return {
            ids,
            replayableEditorNoteIds,
            hasChanges,
            hasUnknownChanges: ids.size === 0 && hasSerializableChanges,
            fingerprint,
        };
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect live PDF.js annotation dirty state', error);
        return {
            ids: new Set<string>(),
            replayableEditorNoteIds: new Set<string>(),
            hasChanges: true,
            hasUnknownChanges: true,
            fingerprint: 'unknown',
        };
    }
}

export function collectLivePdfJsAnnotationChangeFingerprint(
    document: PDFDocumentProxy | null | undefined,
) {
    return collectLivePdfJsAnnotationChangeIds(document).fingerprint;
}
