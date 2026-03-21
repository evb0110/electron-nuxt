import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { debounce } from 'es-toolkit/function';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getCommentText,
    hasEditorCommentPayload,
    toMarkerRectFromEditor,
    detectEditorSubtype,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import {
    parsePdfDateTimestamp,
    getAnnotationCommentText,
    getAnnotationAuthor,
    annotationKindLabelFromSubtype,
    isPopupSubtype,
    isLinkSubtype,
    isTextMarkupSubtype,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    normalizeMarkerRect,
    normalizePageRotation,
    toMarkerRectFromEditorRect,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import { toCssColor } from '@app/composables/pdf/annotationCssUtils';
import {
    getOptionalFunction,
    getOptionalNumber,
    getOptionalNumberArray,
    getOptionalString,
} from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';

function isMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return (
        value === 'Highlight'
        || value === 'Underline'
        || value === 'StrikeOut'
        || value === 'Squiggly'
    );
}

interface ISyncIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
    computeSummaryStableKey: (params: {
        pageIndex: number;
        id: string;
        source: IAnnotationCommentSummary['source'];
        uid?: string | null;
        annotationId?: string | null;
    }) => string;
    toSummaryKey: (summary: IAnnotationCommentSummary) => string;
    rememberSummaryText: (summary: IAnnotationCommentSummary) => void;
    hydrateSummaryFromMemory: (summary: IAnnotationCommentSummary) => IAnnotationCommentSummary;
    mergeCommentSummaries: (existing: IAnnotationCommentSummary, incoming: IAnnotationCommentSummary) => IAnnotationCommentSummary;
    dedupeAnnotationCommentSummaries: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary[];
    clearMemory: () => void;
}

interface ISyncMarkupSubtype {
    resolveEditorMarkupSubtypeOverride: (editor: IPdfjsEditor, pageIndex: number) => TMarkupSubtype | null;
    syncMarkupSubtypePresentationForEditors: () => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    clearOverrides: () => void;
}

interface ISyncStore {
    setAnnotations: (comments: IAnnotationCommentSummary[]) => void;
    setLinkAnnotations: (links: ILinkAnnotation[]) => void;
    setActiveKey: (key: string | null) => void;
}

interface IUseAnnotationSyncOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    authorName: Ref<string | null | undefined>;
    getIdentity: () => ISyncIdentity;
    getMarkupSubtype: () => ISyncMarkupSubtype;
    getStore: () => ISyncStore;
    syncInlineCommentIndicators: () => void;
    debounceMs?: number;
}

export function useAnnotationSync(options: IUseAnnotationSyncOptions) {
    const { t } = useTypedI18n();

    const {
        pdfDocument,
        numPages,
        annotationUiManager,
        authorName,
        getIdentity,
        getMarkupSubtype,
        getStore,
        syncInlineCommentIndicators,
        debounceMs = 140,
    } = options;

    let syncToken = 0;
    const pendingCommentEditorKeys = new Set<string>();
    const trackedCreatedEditors = new WeakSet<object>();
    const suppressedAnnotationIds = new Set<string>();

    function suppressAnnotationId(id: string) {
        suppressedAnnotationIds.add(id);
    }

    function clearSuppressedAnnotationIds() {
        suppressedAnnotationIds.clear();
    }

    watch(pdfDocument, () => {
        clearSuppressedAnnotationIds();
    });

    function toEditorSummary(
        editor: IPdfjsEditor,
        pageIndex: number,
        textOverride?: string,
        sortIndex: number | null = null,
    ): IAnnotationCommentSummary {
        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();

        let data: ReturnType<NonNullable<IPdfjsEditor['getData']>> = {};
        try {
            data = editor.getData?.() ?? {};
        } catch (error) {
            BrowserLogger.debug(
                'annotations',
                'Failed to read annotation editor data payload',
                error,
            );
            data = {};
        }

        const text = typeof textOverride === 'string'
            ? textOverride
            : getCommentText(editor);

        const resolvedSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex)
            ?? detectEditorSubtype(editor);

        const uid = editor.uid ?? null;
        const annotationId = editor.annotationElementId ?? null;

        if (
            annotationId
            && resolvedSubtype
            && resolvedSubtype !== 'Highlight'
            && resolvedSubtype !== 'Ink'
            && resolvedSubtype !== 'Typewriter'
        ) {
            if (isMarkupSubtype(resolvedSubtype)) {
                markupSubtype.getMarkupSubtypeOverrides().set(
                    annotationId,
                    resolvedSubtype,
                );
            }
        }

        const id = identity.getEditorIdentity(editor, pageIndex);
        const pendingKey = identity.getEditorPendingKey(editor, pageIndex);
        const hasNote = hasEditorCommentPayload(editor)
            || pendingCommentEditorKeys.has(pendingKey);

        const editorRotation = normalizePageRotation(
            getOptionalNumber(editor, 'pageRotation')
            ?? getOptionalNumber(editor, 'rotation')
            ?? 0,
        );
        const directEditorRect = normalizeMarkerRect({
            left: editor.x ?? Number.NaN,
            top: editor.y ?? Number.NaN,
            width: editor.width ?? Number.NaN,
            height: editor.height ?? Number.NaN,
        });
        const markerRectFromEditor = directEditorRect
            ? toMarkerRectFromEditorRect(directEditorRect, editorRotation)
            : toMarkerRectFromEditor(editor);
        const pendingAnchorRect = normalizeMarkerRect(editor.__evbPendingAnchorRect ?? null);
        const markerDistanceFromPending = markerRectCenterDistance(markerRectFromEditor, pendingAnchorRect);
        const shouldUsePendingAnchor = Boolean(
            pendingAnchorRect
            && (
                !markerRectFromEditor
                || markerDistanceFromPending > 0.14
            ),
        );
        const markerRect = shouldUsePendingAnchor
            ? pendingAnchorRect
            : markerRectFromEditor;

        if (shouldUsePendingAnchor) {
            BrowserLogger.debug('note-anchor', 'toEditorSummary', {
                pageIndex,
                pageNumber: pageIndex + 1,
                id,
                uid,
                annotationId,
                subtype: resolvedSubtype ?? null,
                hasNote,
                textLength: text.length,
                markerRectFromEditor,
                pendingAnchorRect,
                markerDistanceFromPending,
                shouldUsePendingAnchor,
                markerRect,
            });
        }

        return {
            id,
            stableKey: identity.computeSummaryStableKey({
                id,
                pageIndex,
                source: 'editor',
                uid,
                annotationId,
            }),
            sortIndex,
            pageIndex,
            pageNumber: pageIndex + 1,
            text,
            kindLabel: annotationKindLabelFromSubtype(resolvedSubtype, t),
            subtype: resolvedSubtype,
            author: authorName.value?.trim() || null,
            modifiedAt: parsePdfDateTimestamp(data.modificationDate)
                ?? parsePdfDateTimestamp(data.creationDate),
            color: toCssColor(
                data.color ?? editor.color,
                data.opacity ?? editor.opacity ?? 1,
            ),
            uid,
            annotationId,
            source: 'editor',
            hasNote,
            markerRect,
        };
    }

    async function syncAnnotationComments() {
        try {
            const identity = getIdentity();
            const markupSubtype = getMarkupSubtype();
            const store = getStore();
            const doc = pdfDocument.value;

            if (!doc || numPages.value <= 0) {
                identity.clearMemory();
                markupSubtype.clearOverrides();
                store.setAnnotations([]);
                store.setLinkAnnotations([]);
                syncInlineCommentIndicators();
                return;
            }

            const localToken = ++syncToken;
            const commentsByKey = new Map<string, IAnnotationCommentSummary>();
            const collectedLinks: ILinkAnnotation[] = [];
            let sourceOrder = 0;

            const uiManager = annotationUiManager.value;
            const isDeletedFn = uiManager
                ? getOptionalFunction<[annotationElementId: string], boolean>(uiManager, 'isDeletedAnnotationElement')
                : null;
            const isDeletedAnnotationElement = isDeletedFn
                ? (id: string) => isDeletedFn.call(uiManager, id)
                : null;

            if (uiManager) {
                for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
                    for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
                        const text = getCommentText(editor);
                        const summary = toEditorSummary(editor, pageIndex, text, sourceOrder);
                        sourceOrder += 1;
                        const hydrated = identity.hydrateSummaryFromMemory(summary);
                        commentsByKey.set(identity.toSummaryKey(hydrated), hydrated);
                    }
                }
            }

            for (let pageNumber = 1; pageNumber <= numPages.value; pageNumber += 1) {
                if (localToken !== syncToken) {
                    return;
                }

                let pageAnnotations: Array<{
                    id?: string;
                    pageIndex?: number;
                    rect?: number[];
                    contents?: string;
                    contentsObj?: { str?: string | null };
                    richText?: { str?: string | null };
                    title?: string;
                    titleObj?: { str?: string | null };
                    color?: number[] | string | null;
                    opacity?: number;
                    modificationDate?: string | null;
                    creationDate?: string | null;
                    subtype?: string;
                    popupRef?: string | null;
                }> = [];
                let pageView: number[] | null = null;
                let pageRotation = normalizePageRotation(0);

                try {
                    const page = await doc.getPage(pageNumber);
                    const rawAnnotations: unknown = await page.getAnnotations();
                    pageAnnotations = Array.isArray(rawAnnotations)
                        ? rawAnnotations as typeof pageAnnotations
                        : [];
                    pageView = getOptionalNumberArray(page, 'view');
                    pageRotation = normalizePageRotation(getOptionalNumber(page, 'rotate') ?? 0);
                } catch (error) {
                    BrowserLogger.debug(
                        'annotations',
                        `Failed to collect annotations for page ${pageNumber}`,
                        error,
                    );
                    continue;
                }

                const popupById = new Map<string, (typeof pageAnnotations)[number]>();
                pageAnnotations.forEach((annotation) => {
                    if (annotation.id && suppressedAnnotationIds.has(annotation.id)) {
                        return;
                    }
                    if (
                        annotation.id
                        && isDeletedAnnotationElement?.(annotation.id)
                    ) {
                        return;
                    }
                    if (!isPopupSubtype(annotation.subtype)) {
                        return;
                    }
                    if (!annotation.id) {
                        return;
                    }
                    popupById.set(annotation.id, annotation);
                });

                pageAnnotations.forEach((annotation, annotationIndex) => {
                    if (annotation.id && suppressedAnnotationIds.has(annotation.id)) {
                        return;
                    }
                    if (
                        annotation.id
                        && isDeletedAnnotationElement?.(annotation.id)
                    ) {
                        return;
                    }
                    if (isPopupSubtype(annotation.subtype)) {
                        return;
                    }
                    if (isLinkSubtype(annotation.subtype)) {
                        const url = getOptionalString(annotation, 'url');
                        if (url && annotation.rect) {
                            const rect = toMarkerRectFromPdfRect(annotation.rect, pageView, pageRotation);
                            if (rect) {
                                collectedLinks.push({
                                    id: annotation.id ?? `link-${pageNumber}-${annotationIndex}`,
                                    pageNumber,
                                    url,
                                    rect,
                                });
                            }
                        }
                        return;
                    }

                    const popupAnnotation = annotation.popupRef
                        ? (popupById.get(annotation.popupRef) ?? null)
                        : null;
                    const annotationText = getAnnotationCommentText(annotation);
                    const popupText = popupAnnotation
                        ? getAnnotationCommentText(popupAnnotation)
                        : '';
                    // Strip ZWS/BOM left by legacy saves so we detect truly-empty /Contents
                    // and fall through to the popup text (see docs/freetext-note-persistence.md)
                    const visibleAnnotationText = annotationText.replace(/[\u200B\uFEFF]/g, '').trim();
                    const text = visibleAnnotationText.length > 0
                        ? annotationText
                        : popupText.length > 0
                            ? popupText
                            : annotationText;
                    const subtype = annotation.subtype ?? null;
                    const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
                    const annotationId = annotation.id ?? null;
                    const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
                    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
                    const isFreeTextNote = normalizedSubtype === 'freetext' && hasLinkedPopup;
                    const summaryKey = identity.computeSummaryStableKey({
                        id,
                        pageIndex: pageNumber - 1,
                        source: 'pdf',
                        uid: null,
                        annotationId,
                    });

                    const summary: IAnnotationCommentSummary = {
                        id,
                        stableKey: summaryKey,
                        sortIndex: sourceOrder,
                        pageIndex: pageNumber - 1,
                        pageNumber,
                        text,
                        kindLabel: annotationKindLabelFromSubtype(subtype, t),
                        subtype,
                        author: getAnnotationAuthor(annotation)
                            ?? (popupAnnotation ? getAnnotationAuthor(popupAnnotation) : null),
                        modifiedAt: (() => {
                            const own = parsePdfDateTimestamp(annotation.modificationDate)
                                ?? parsePdfDateTimestamp(annotation.creationDate);
                            const popup = popupAnnotation
                                ? (parsePdfDateTimestamp(popupAnnotation.modificationDate)
                                    ?? parsePdfDateTimestamp(popupAnnotation.creationDate))
                                : null;
                            if (own && popup) {
                                return Math.max(own, popup);
                            }
                            return own ?? popup;
                        })(),
                        color: toCssColor(
                            annotation.color ?? popupAnnotation?.color ?? null,
                            annotation.opacity ?? popupAnnotation?.opacity ?? 1,
                        ),
                        uid: null,
                        annotationId,
                        source: 'pdf',
                        hasNote: Boolean(
                            (isTextMarkupSubtype(subtype) || isFreeTextNote)
                            && (hasLinkedPopup || text.trim().length > 0),
                        ),
                        markerRect: toMarkerRectFromPdfRect(
                            annotation.rect ?? popupAnnotation?.rect,
                            pageView,
                            pageRotation,
                        ),
                    };

                    if (
                        annotationId
                        && (normalizedSubtype === 'underline'
                            || normalizedSubtype === 'strikeout'
                            || normalizedSubtype === 'squiggly')
                        && isMarkupSubtype(subtype)
                    ) {
                        markupSubtype.getMarkupSubtypeOverrides().set(annotationId, subtype);
                    }

                    sourceOrder += 1;
                    const hydratedSummary = identity.hydrateSummaryFromMemory(summary);

                    const existing = commentsByKey.get(summaryKey);
                    if (!existing) {
                        commentsByKey.set(summaryKey, hydratedSummary);
                        return;
                    }
                    commentsByKey.set(
                        summaryKey,
                        identity.mergeCommentSummaries(existing, hydratedSummary),
                    );
                });
            }

            if (localToken !== syncToken) {
                return;
            }

            const comments = identity.dedupeAnnotationCommentSummaries(
                Array.from(commentsByKey.values()),
            );
            comments.forEach((comment) => {
                identity.rememberSummaryText(comment);
            });

            store.setAnnotations(comments);
            store.setLinkAnnotations(collectedLinks);
            markupSubtype.syncMarkupSubtypePresentationForEditors();
            syncInlineCommentIndicators();
        } catch (error) {
            BrowserLogger.error(
                'annotations',
                'Failed to synchronize annotation comments',
                error,
            );
        }
    }

    const debouncedSync = debounce(() => {
        runGuardedTask(() => syncAnnotationComments(), {
            scope: 'annotations',
            message: 'Failed to synchronize annotation comments (debounced)',
        });
    }, debounceMs);

    function scheduleAnnotationCommentsSync(immediate = false) {
        if (immediate) {
            debouncedSync.cancel();
            runGuardedTask(() => syncAnnotationComments(), {
                scope: 'annotations',
                message: 'Failed to synchronize annotation comments',
            });
            return;
        }
        debouncedSync();
    }

    function setActiveCommentStableKey(stableKey: string | null) {
        getStore().setActiveKey(stableKey);
    }

    function incrementSyncToken() {
        syncToken += 1;
    }

    function clearSyncState() {
        syncToken += 1;
        debouncedSync.cancel();
        pendingCommentEditorKeys.clear();
        getIdentity().clearMemory();
        getMarkupSubtype().clearOverrides();
    }

    tryOnScopeDispose(() => {
        debouncedSync.cancel();
        syncToken += 1;
    });

    return {
        pendingCommentEditorKeys,
        trackedCreatedEditors,
        toEditorSummary,
        syncAnnotationComments,
        scheduleAnnotationCommentsSync,
        setActiveCommentStableKey,
        incrementSyncToken,
        clearSyncState,
        suppressAnnotationId,
        clearSuppressedAnnotationIds,
    };
}
