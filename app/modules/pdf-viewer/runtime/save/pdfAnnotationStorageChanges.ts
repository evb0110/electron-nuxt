import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { isRecord } from '@contracts/runtimeGuards';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {IPdfNativeFreeTextEditor} from '@contracts/electronApiDocuments';
import {requirePageIndex} from '@contracts/pageNumbers';
import type { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';
import { getAnnotationStorageRawValue } from '@app/services/pdfjs/annotationEditorAdapter';

export interface IPdfLiveAnnotationChangeSummary {
    ids: Set<string>;
    replayableEditorNoteIds: Set<string>;
    nativeFreeTextEditors: Map<string, IPdfNativeFreeTextEditor>;
    hasChanges: boolean;
    hasUnknownChanges: boolean;
    fingerprint: string;
}

/**
 * Read-only diagnostics for proving that the retired PDF.js editor storage
 * stays untouched while the canonical annotation surface is active.
 */
export interface IPdfAnnotationStorageDebugState {
    reported: boolean;
    modifiedIds: string[];
    serializableEntryKeys: string[];
}

export function collectPdfJsAnnotationStorageDebugState(
    document: PDFDocumentProxy | null | undefined,
): IPdfAnnotationStorageDebugState {
    const storage = getPdfJsAnnotationStorage(document);
    if (!storage || typeof storage !== 'object') {
        return {
            reported: false,
            modifiedIds: [],
            serializableEntryKeys: [],
        };
    }

    try {
        const modifiedIds = storage.modifiedIds?.ids;
        const serializableMap = storage.serializable?.map;
        return {
            reported: modifiedIds instanceof Set && serializableMap instanceof Map,
            modifiedIds: modifiedIds instanceof Set
                ? Array.from(modifiedIds).map(String)
                : [],
            serializableEntryKeys: serializableMap instanceof Map
                ? Array.from(serializableMap.keys()).map(String)
                : [],
        };
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect PDF.js annotation storage', error);
        return {
            reported: false,
            modifiedIds: [],
            serializableEntryKeys: [],
        };
    }
}

/** Unions two observations of the same annotation save work into one summary. */
export function mergeLivePdfJsAnnotationChanges(
    left: IPdfLiveAnnotationChangeSummary,
    right: IPdfLiveAnnotationChangeSummary,
): IPdfLiveAnnotationChangeSummary {
    return {
        ids: new Set([
            ...left.ids,
            ...right.ids,
        ]),
        replayableEditorNoteIds: new Set([
            ...left.replayableEditorNoteIds,
            ...right.replayableEditorNoteIds,
        ]),
        nativeFreeTextEditors: new Map([
            ...left.nativeFreeTextEditors,
            ...right.nativeFreeTextEditors,
        ]),
        hasChanges: left.hasChanges || right.hasChanges,
        hasUnknownChanges: left.hasUnknownChanges || right.hasUnknownChanges,
        fingerprint: `${left.fingerprint}|pdfjs:${right.fingerprint}`,
    };
}

/**
 * A preserved PDF.js session can keep serializable editor records after their
 * modified state returns to the exact saved baseline. Only an authoritative,
 * known fingerprint match proves those records are not live save work.
 */
export function normalizeLivePdfJsAnnotationChangesAgainstSavedFingerprint(
    summary: IPdfLiveAnnotationChangeSummary,
    savedFingerprint: string | null | undefined,
): IPdfLiveAnnotationChangeSummary {
    if (
        !savedFingerprint
        || savedFingerprint === 'unknown'
        || summary.hasUnknownChanges
        || summary.fingerprint !== savedFingerprint
    ) {
        return summary;
    }
    return {
        ids: new Set(),
        replayableEditorNoteIds: new Set(),
        nativeFreeTextEditors: new Map(),
        hasChanges: false,
        hasUnknownChanges: false,
        fingerprint: EMPTY_ANNOTATION_CHANGE_FINGERPRINT,
    };
}

const PDFJS_FREETEXT_ANNOTATION_EDITOR_TYPE = 3;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;
const EMPTY_ANNOTATION_CHANGE_FINGERPRINT = 'empty';
const MAX_NATIVE_FREE_TEXT_EDITOR_TEXT_LENGTH = 64 * 1024;
const MAX_NATIVE_FREE_TEXT_EDITOR_KEY_LENGTH = 512;
const nativeFreeTextEditorStableKeys = new WeakMap<PDFDocumentProxy, Map<string, string>>();
const MARKER_RECT_TOLERANCE = 0.0001;

interface ICollectLivePdfJsAnnotationChangeOptions {annotationStore?: Pick<AnnotationStore, 'get'> | undefined;}

type TAnnotationStorageResetMethod = 'resetModified' | 'resetModifiedIds';

function getPdfJsAnnotationStorage(document: PDFDocumentProxy | null | undefined) {
    return document?.annotationStorage;
}

/**
 * PDF.js serializes new editors in AnnotationStorage map insertion order, then
 * preserves that per-page order while allocating and appending annotation refs.
 * Capture the editor keys before saveDocument so post-save identity binding can
 * correlate canonical editor UIDs to refs without geometry matching.
 */
export function collectNewPdfJsAnnotationStorageEditorOrder(
    document: PDFDocumentProxy | null | undefined,
) {
    const storage = getPdfJsAnnotationStorage(document);
    if (!storage || typeof storage !== 'object') {
        return [];
    }
    const serializable = Reflect.get(storage, 'serializable') as unknown;
    if (!isRecord(serializable)) {
        return [];
    }
    const map = serializable.map;
    if (!(map instanceof Map)) {
        return [];
    }
    return [...map.entries()].flatMap(([
        key,
        value,
    ]) => {
        if (
            typeof key !== 'string'
            || !key.startsWith('pdfjs_internal_editor_')
            || !isRecord(value)
            || value.deleted === true
            || getExistingPdfAnnotationIdFromStorageValue(value)
        ) {
            return [];
        }
        return [key];
    });
}

function callPdfJsAnnotationStorageResetMethod(
    document: PDFDocumentProxy | null | undefined,
    method: TAnnotationStorageResetMethod,
) {
    const storage = getPdfJsAnnotationStorage(document);
    if (!storage || typeof storage !== 'object') {
        return false;
    }

    const resetMethod = (storage as Record<TAnnotationStorageResetMethod, unknown>)[method];
    if (typeof resetMethod !== 'function') {
        return false;
    }

    resetMethod.call(storage);
    return true;
}

export function resetLivePdfJsAnnotationStorageModifiedIds(
    document: PDFDocumentProxy | null | undefined,
) {
    try {
        return callPdfJsAnnotationStorageResetMethod(document, 'resetModifiedIds');
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to reset PDF.js annotation storage modified ids', error);
        return false;
    }
}

export function resetLivePdfJsAnnotationStorageModifiedState(
    document: PDFDocumentProxy | null | undefined,
) {
    try {
        return callPdfJsAnnotationStorageResetMethod(document, 'resetModified');
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to reset PDF.js annotation storage modified state', error);
        return false;
    }
}

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

function markerRectsMatch(
    left: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
    right: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
) {
    return Math.abs(left.left - right.left) <= MARKER_RECT_TOLERANCE
        && Math.abs(left.top - right.top) <= MARKER_RECT_TOLERANCE
        && Math.abs(left.width - right.width) <= MARKER_RECT_TOLERANCE
        && Math.abs(left.height - right.height) <= MARKER_RECT_TOLERANCE;
}

function isPersistedCleanCommentMarkerAnchor(input: {
    document: PDFDocumentProxy;
    keyId: string | null;
    value: unknown;
    annotationStore: Pick<AnnotationStore, 'get'> | undefined;
}) {
    if (
        !input.keyId
        || !input.annotationStore
        || !isRecord(input.value)
        || input.value.deleted === true
        || !isFreeTextEditorStorageValue(input.value)
        || !isBlankStringValue(input.value.value)
        || hasTextPayload(input.value.comment)
    ) {
        return false;
    }
    const popup = input.value.popup;
    if (!isRecord(popup) || popup.deleted === true || typeof popup.contents !== 'string') {
        return false;
    }
    const editor = getAnnotationStorageRawValue(input.document, input.keyId);
    if (!editor || typeof editor !== 'object') {
        return false;
    }
    const editorState = getPdfjsEditorFacadeState(editor);
    if (
        editorState.commentMarkerAnchor !== true
        || typeof editorState.canonicalAnnotationId !== 'string'
        || !editorState.pendingAnchorRect
    ) {
        return false;
    }
    const entity = input.annotationStore.get(asAnnotationId(editorState.canonicalAnnotationId));
    return entity?.kind === 'note'
        && !entity.deleted
        && Boolean(entity.identity.pdfRef)
        && entity.revision === entity.persistedRevision
        && entity.pageIndex === input.value.pageIndex
        && markerRectsMatch(editorState.pendingAnchorRect, entity.position)
        && popup.contents.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '')
        === entity.contents.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '');
}

function isCanonicalManagedShapeEditorStorage(input: {
    document: PDFDocumentProxy;
    keyId: string | null;
    annotationStore: Pick<AnnotationStore, 'get'> | undefined;
}) {
    if (!input.keyId || !input.annotationStore) {
        return false;
    }
    const editor = getAnnotationStorageRawValue(input.document, input.keyId);
    if (!editor || typeof editor !== 'object') {
        return false;
    }
    const canonicalAnnotationId = getPdfjsEditorFacadeState(editor).canonicalAnnotationId;
    if (typeof canonicalAnnotationId !== 'string') {
        return false;
    }
    return input.annotationStore.get(asAnnotationId(canonicalAnnotationId))?.kind === 'shape';
}

function isReplayableFreeTextNoteStorageValue(value: unknown) {
    if (!isRecord(value) || value.deleted === true) {
        return false;
    }
    if (!isFreeTextEditorStorageValue(value)) {
        return false;
    }

    // PDF.js serializes a changed legacy Popup alongside the visible FreeText
    // value. A non-point imported FreeText can have that Popup too, but its
    // non-blank value is still the native editor payload we need to preserve.
    // App note markers use a blank (or zero-width) visible value, so keep that
    // shape and explicit comment payloads on the note replay path.
    return isBlankStringValue(value.value)
        || hasTextPayload(value.comment)
        || value.hasComment === true;
}

function isUntrackedBlankEditorOnlyFreeTextStorageValue(
    value: unknown,
    keyId: string | null,
    modifiedIds: Set<unknown> | undefined,
) {
    return isRecord(value)
        && keyId !== null
        && modifiedIds?.has(keyId) !== true
        && value.deleted !== true
        && !getExistingPdfAnnotationIdFromStorageValue(value)
        && isFreeTextEditorStorageValue(value)
        && isBlankStringValue(value.value)
        && !hasActivePopupPayload(value)
        && !hasTextPayload(value.comment)
        && value.hasComment !== true;
}

function normalizeNativeFreeTextEditorText(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '');
    return !isBlankStringValue(normalized)
        && normalized.length <= MAX_NATIVE_FREE_TEXT_EDITOR_TEXT_LENGTH
        && Array.from(normalized).every(character => (
            character === '\n'
            || character === '\t'
            || (character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) <= 0x7e)
        ))
        ? normalized
        : null;
}

function isNativeFreeTextEditorRect(value: unknown): value is [number, number, number, number] {
    if (
        !Array.isArray(value)
        || value.length !== 4
        || value.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
    ) {
        return false;
    }
    const [
        x1,
        y1,
        x2,
        y2,
    ] = value as [number, number, number, number];
    return x2 > x1 && y2 > y1;
}

function isNativeFreeTextEditorColor(value: unknown): value is [number, number, number] {
    return Array.isArray(value)
        && value.length === 3
        && value.every(component => (
            typeof component === 'number'
            && Number.isInteger(component)
            && component >= 0
            && component <= 255
        ));
}

type TNativeFreeTextEditorStyle = Record<string, unknown> & {
    color: [number, number, number];
    fontSize: number;
    rotation: 0 | 90 | 180 | 270;
};

function hasNativeFreeTextEditorStyle(value: Record<string, unknown>): value is TNativeFreeTextEditorStyle {
    return [
        0,
        90,
        180,
        270,
    ].includes(value.rotation as number)
        && typeof value.fontSize === 'number'
        && Number.isFinite(value.fontSize)
        && value.fontSize > 0
        && value.fontSize <= 512
        && isNativeFreeTextEditorColor(value.color);
}

function toNativeFreeTextEditor(
    document: PDFDocumentProxy,
    key: string,
    value: unknown,
): IPdfNativeFreeTextEditor | null {
    const nativeText = isRecord(value)
        ? normalizeNativeFreeTextEditorText(value.value)
        : null;
    const existingAnnotationId = getExistingPdfAnnotationIdFromStorageValue(value);
    if (
        !key.startsWith('pdfjs_internal_editor_')
        || !isRecord(value)
        || value.deleted === true
        || !isFreeTextEditorStorageValue(value)
        || isReplayableFreeTextNoteStorageValue(value)
        || nativeText === null
        || typeof value.pageIndex !== 'number'
        || !Number.isSafeInteger(value.pageIndex)
        || value.pageIndex < 0
        || !isNativeFreeTextEditorRect(value.rect)
        || !hasNativeFreeTextEditorStyle(value)
        || key.length > MAX_NATIVE_FREE_TEXT_EDITOR_KEY_LENGTH
    ) {
        return null;
    }

    let stableKeys = nativeFreeTextEditorStableKeys.get(document);
    if (!stableKeys) {
        stableKeys = new Map<string, string>();
        nativeFreeTextEditorStableKeys.set(document, stableKeys);
    }
    let stableKey = existingAnnotationId
        ? `pdf-ref-${existingAnnotationId}`
        : stableKeys.get(key);
    if (!stableKey) {
        stableKey = `freetext-${crypto.randomUUID()}`;
        stableKeys.set(key, stableKey);
    }

    return {
        pageIndex: requirePageIndex(value.pageIndex),
        stableKey,
        ...(existingAnnotationId ? {annotationId: existingAnnotationId} : {}),
        text: nativeText,
        rect: [...value.rect],
        rotation: value.rotation,
        fontSize: value.fontSize,
        color: [...value.color],
    };
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
    options: ICollectLivePdfJsAnnotationChangeOptions = {},
): IPdfLiveAnnotationChangeSummary {
    if (!document) {
        return {
            ids: new Set<string>(),
            replayableEditorNoteIds: new Set<string>(),
            nativeFreeTextEditors: new Map<string, IPdfNativeFreeTextEditor>(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: EMPTY_ANNOTATION_CHANGE_FINGERPRINT,
        };
    }

    try {
        const storage = getPdfJsAnnotationStorage(document);
        resetCachedModifiedIds(storage);
        const ids = new Set<string>();
        const replayableEditorNoteIds = new Set<string>();
        const nativeFreeTextEditors = new Map<string, IPdfNativeFreeTextEditor>();
        const serializableRuntimeIdsMappedToPdfRefs = new Set<string>();
        const excludedRuntimeIds = new Set<string>();
        const countedSerializableEntries: Array<[string, unknown]> = [];
        const serializable = storage?.serializable;
        const serializableMap = serializable?.map;
        const modifiedIds = storage?.modifiedIds?.ids;
        let hasSerializableChanges = false;

        if (serializableMap instanceof Map && serializableMap.size > 0) {
            serializableMap.forEach((value: unknown, key: unknown) => {
                const keyId = normalizePdfJsAnnotationId(typeof key === 'string' ? key : String(key));
                if (
                    isDeletedEditorOnlyStorageValue(value)
                    || isUntrackedBlankEditorOnlyFreeTextStorageValue(value, keyId, modifiedIds)
                    || isPersistedCleanCommentMarkerAnchor({
                        document,
                        keyId,
                        value,
                        annotationStore: options.annotationStore,
                    })
                    || isCanonicalManagedShapeEditorStorage({
                        document,
                        keyId,
                        annotationStore: options.annotationStore,
                    })
                ) {
                    if (keyId) {
                        excludedRuntimeIds.add(keyId);
                    }
                    return;
                }

                hasSerializableChanges = true;
                countedSerializableEntries.push([
                    typeof key === 'string' ? key : String(key),
                    value,
                ]);
                const existingPdfAnnotationId = getExistingPdfAnnotationIdFromStorageValue(value);
                if (existingPdfAnnotationId) {
                    ids.add(existingPdfAnnotationId);
                    if (isReplayableFreeTextNoteStorageValue(value)) {
                        replayableEditorNoteIds.add(existingPdfAnnotationId);
                    }
                    if (keyId) {
                        serializableRuntimeIdsMappedToPdfRefs.add(keyId);
                    }
                    const nativeFreeTextEditor = toNativeFreeTextEditor(
                        document,
                        keyId ?? existingPdfAnnotationId,
                        value,
                    );
                    if (nativeFreeTextEditor) {
                        nativeFreeTextEditors.set(existingPdfAnnotationId, nativeFreeTextEditor);
                    }
                    return;
                }

                if (keyId) {
                    ids.add(keyId);
                    if (isReplayableFreeTextNoteStorageValue(value)) {
                        replayableEditorNoteIds.add(keyId);
                    }
                    const nativeFreeTextEditor = toNativeFreeTextEditor(document, keyId, value);
                    if (nativeFreeTextEditor) {
                        nativeFreeTextEditors.set(keyId, nativeFreeTextEditor);
                    }
                }
            });
        }

        if (typeof modifiedIds?.size === 'number' && modifiedIds.size > 0) {
            modifiedIds.forEach((id: unknown) => {
                const normalized = normalizeModifiedAnnotationStorageId(id);
                if (
                    normalized
                    && !serializableRuntimeIdsMappedToPdfRefs.has(normalized)
                    && !excludedRuntimeIds.has(normalized)
                ) {
                    ids.add(normalized);
                }
            });
        }

        const hasChanges = ids.size > 0 || hasSerializableChanges;
        const fingerprint = hasChanges
            ? JSON.stringify({
                ids: [...ids].sort(),
                serializable: countedSerializableEntries
                    .sort(([left], [right]) => left.localeCompare(right)),
            })
            : EMPTY_ANNOTATION_CHANGE_FINGERPRINT;

        return {
            ids,
            replayableEditorNoteIds,
            nativeFreeTextEditors,
            hasChanges,
            hasUnknownChanges: ids.size === 0 && hasSerializableChanges,
            fingerprint,
        };
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect live PDF.js annotation dirty state', error);
        return {
            ids: new Set<string>(),
            replayableEditorNoteIds: new Set<string>(),
            nativeFreeTextEditors: new Map<string, IPdfNativeFreeTextEditor>(),
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
