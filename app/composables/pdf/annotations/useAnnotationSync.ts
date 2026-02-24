import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { debounce } from 'es-toolkit/function';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
    IPdfjsEditor,
} from '@app/composables/pdf/annotations/types';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/types';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    getCommentText,
    hasEditorCommentPayload,
    parsePdfDateTimestamp,
    toCssColor,
    toMarkerRectFromPdfRect,
    toMarkerRectFromEditor,
    getAnnotationCommentText,
    getAnnotationAuthor,
    annotationKindLabelFromSubtype,
    isPopupSubtype,
    detectEditorSubtype,
    isTextMarkupSubtype,
    normalizeMarkerRect,
} from '@app/composables/pdf/pdfAnnotationUtils';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';

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
            : getCommentText(editor).trim();

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
            const normalized = resolvedSubtype.toLowerCase();
            if (
                normalized === 'underline'
                || normalized === 'strikeout'
                || normalized === 'squiggly'
            ) {
                markupSubtype.getMarkupSubtypeOverrides().set(
                    annotationId,
                    resolvedSubtype as TMarkupSubtype,
                );
            }
        }

        const id = identity.getEditorIdentity(editor, pageIndex);
        const pendingKey = identity.getEditorPendingKey(editor, pageIndex);
        const hasNote = hasEditorCommentPayload(editor)
            || pendingCommentEditorKeys.has(pendingKey);

        const markerRectFromEditor = toMarkerRectFromEditor(editor);
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
                syncInlineCommentIndicators();
                return;
            }

            const localToken = ++syncToken;
            const commentsByKey = new Map<string, IAnnotationCommentSummary>();
            let sourceOrder = 0;

            const uiManager = annotationUiManager.value;
            const managerWithDeletedLookup = uiManager as
                | (AnnotationEditorUIManager & {isDeletedAnnotationElement?: (annotationElementId: string) => boolean;})
                | null;

            if (uiManager) {
                for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
                    for (const editor of uiManager.getEditors(pageIndex)) {
                        const normalizedEditor = editor as IPdfjsEditor;
                        const text = getCommentText(normalizedEditor).trim();
                        const summary = toEditorSummary(normalizedEditor, pageIndex, text, sourceOrder);
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

                try {
                    const page = await doc.getPage(pageNumber);
                    pageAnnotations = await page.getAnnotations();
                    pageView = (page as { view?: number[] }).view ?? null;
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
                    if (
                        annotation.id
                        && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)
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
                    if (
                        annotation.id
                        && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)
                    ) {
                        return;
                    }
                    if (isPopupSubtype(annotation.subtype)) {
                        return;
                    }

                    const popupAnnotation = annotation.popupRef
                        ? (popupById.get(annotation.popupRef) ?? null)
                        : null;
                    const annotationText = getAnnotationCommentText(annotation);
                    const popupText = popupAnnotation
                        ? getAnnotationCommentText(popupAnnotation)
                        : '';
                    const text = annotationText || popupText;
                    const subtype = annotation.subtype ?? null;
                    const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
                    const annotationId = annotation.id ?? null;
                    const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
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
                            isTextMarkupSubtype(subtype)
                            && (hasLinkedPopup || text.trim().length > 0),
                        ),
                        markerRect: toMarkerRectFromPdfRect(
                            annotation.rect ?? popupAnnotation?.rect,
                            pageView,
                        ),
                    };

                    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
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
    };
}
