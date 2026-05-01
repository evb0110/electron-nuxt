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
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getCommentText,
    hasEditorCommentPayload,
    detectEditorSubtype,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import { parsePdfDateTimestamp } from '@app/services/pdf/annotation-metadata';
import { annotationKindLabelFromSubtype } from '@app/services/pdf/annotation-subtype';
import { toCssColor } from '@app/composables/pdf/annotationCssUtils';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';
import {
    collectPagePdfSnapshotEntries,
    isMarkupSubtype,
    loadPdfPageAnnotations,
    resolveEditorMarkerRect,
    resolveMarkupSubtypeOverrideRegistration,
    safeReadEditorData,
} from '@app/composables/pdf/annotations/annotationSyncHelpers';
import type { TComputeSummaryStableKey } from '@app/composables/pdf/annotations/annotationSyncHelpers';

interface ISyncIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
    computeSummaryStableKey: TComputeSummaryStableKey;
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

interface IPdfAnnotationSnapshot {
    doc: PDFDocumentProxy;
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
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
    let syncRunPromise: Promise<void> | null = null;
    let syncRerunRequested = false;
    const pendingCommentEditorKeys = new Set<string>();
    const trackedCreatedEditors = new WeakSet<object>();
    const suppressedAnnotationIds = new Set<string>();
    const suppressedAnnotationStableKeys = new Set<string>();
    let pdfAnnotationSnapshot: IPdfAnnotationSnapshot | null = null;
    let pdfAnnotationSnapshotVersion = 0;
    let pdfAnnotationSnapshotPromise: {
        doc: PDFDocumentProxy;
        pageCount: number;
        version: number;
        promise: Promise<IPdfAnnotationSnapshot | null>;
    } | null = null;

    function resetPdfAnnotationSnapshot() {
        pdfAnnotationSnapshotVersion += 1;
        pdfAnnotationSnapshot = null;
        pdfAnnotationSnapshotPromise = null;
    }

    function resolveAnnotationKindLabel(subtype: string | null | undefined) {
        const { key } = annotationKindLabelFromSubtype(subtype);
        return t(key);
    }

    function suppressAnnotationId(id: string) {
        suppressedAnnotationIds.add(id);
    }

    function suppressAnnotationStableKey(stableKey: string) {
        if (!stableKey) {
            return;
        }
        suppressedAnnotationStableKeys.add(stableKey);
    }

    function clearSuppressedAnnotationIds() {
        suppressedAnnotationIds.clear();
        suppressedAnnotationStableKeys.clear();
    }

    watch(pdfDocument, () => {
        clearSuppressedAnnotationIds();
        resetPdfAnnotationSnapshot();
    });

    function toEditorSummary(
        editor: IPdfjsEditor,
        pageIndex: number,
        textOverride?: string,
        sortIndex: number | null = null,
    ): IAnnotationCommentSummary {
        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();

        const data = safeReadEditorData(editor);

        const text = typeof textOverride === 'string'
            ? textOverride
            : getCommentText(editor);

        const resolvedSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex)
            ?? detectEditorSubtype(editor);

        const uid = editor.uid ?? null;
        const annotationId = editor.annotationElementId ?? null;

        const overrideRegistration = resolveMarkupSubtypeOverrideRegistration(annotationId, resolvedSubtype);
        if (overrideRegistration) {
            markupSubtype.getMarkupSubtypeOverrides().set(
                overrideRegistration.annotationId,
                overrideRegistration.subtype,
            );
        }

        const id = identity.getEditorIdentity(editor, pageIndex);
        const pendingKey = identity.getEditorPendingKey(editor, pageIndex);
        const hasNote = hasEditorCommentPayload(editor)
            || pendingCommentEditorKeys.has(pendingKey);

        const rectResult = resolveEditorMarkerRect(editor);

        if (rectResult.shouldUsePendingAnchor) {
            BrowserLogger.debug('note-anchor', 'toEditorSummary', {
                pageIndex,
                pageNumber: pageIndex + 1,
                id,
                uid,
                annotationId,
                subtype: resolvedSubtype ?? null,
                hasNote,
                textLength: text.length,
                markerRectFromEditor: rectResult.markerRectFromEditor,
                pendingAnchorRect: rectResult.pendingAnchorRect,
                markerDistanceFromPending: rectResult.markerDistanceFromPending,
                shouldUsePendingAnchor: rectResult.shouldUsePendingAnchor,
                markerRect: rectResult.markerRect,
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
            kindLabel: resolveAnnotationKindLabel(resolvedSubtype),
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
            markerRect: rectResult.markerRect,
        };
    }

    async function collectPdfAnnotationSnapshot(
        doc: PDFDocumentProxy,
        pageCount: number,
        localToken: number,
    ): Promise<IPdfAnnotationSnapshot | null> {
        const identity = getIdentity();
        const comments: IAnnotationCommentSummary[] = [];
        const links: ILinkAnnotation[] = [];
        const summaryDeps: IPdfCommentSummaryDeps = {
            computeStableKey: identity.computeSummaryStableKey,
            resolveKindLabel: resolveAnnotationKindLabel,
        };

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            if (localToken !== syncToken) {
                return null;
            }

            const pageBundle = await loadPdfPageAnnotations(doc, pageNumber);
            if (!pageBundle) {
                continue;
            }

            collectPagePdfSnapshotEntries(
                pageBundle,
                pageNumber,
                summaryDeps,
                comments,
                links,
            );
        }

        return {
            doc,
            pageCount,
            comments,
            links,
        };
    }

    async function getPdfAnnotationSnapshot(
        doc: PDFDocumentProxy,
        pageCount: number,
        localToken: number,
    ): Promise<IPdfAnnotationSnapshot | null> {
        if (
            pdfAnnotationSnapshot
            && pdfAnnotationSnapshot.doc === doc
            && pdfAnnotationSnapshot.pageCount === pageCount
        ) {
            return pdfAnnotationSnapshot;
        }

        if (
            pdfAnnotationSnapshotPromise
            && pdfAnnotationSnapshotPromise.doc === doc
            && pdfAnnotationSnapshotPromise.pageCount === pageCount
            && pdfAnnotationSnapshotPromise.version === pdfAnnotationSnapshotVersion
        ) {
            return pdfAnnotationSnapshotPromise.promise;
        }

        const snapshotVersion = pdfAnnotationSnapshotVersion;
        const snapshotPromise = collectPdfAnnotationSnapshot(doc, pageCount, localToken)
            .then((snapshot) => {
                if (
                    snapshot
                    && snapshotVersion === pdfAnnotationSnapshotVersion
                    && pdfDocument.value === doc
                    && numPages.value === pageCount
                ) {
                    pdfAnnotationSnapshot = snapshot;
                }
                return snapshot;
            })
            .finally(() => {
                if (pdfAnnotationSnapshotPromise?.promise === snapshotPromise) {
                    pdfAnnotationSnapshotPromise = null;
                }
            });

        pdfAnnotationSnapshotPromise = {
            doc,
            pageCount,
            version: snapshotVersion,
            promise: snapshotPromise,
        };

        return snapshotPromise;
    }

    async function syncAnnotationCommentsInternal() {
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

        const pdfSnapshot = await getPdfAnnotationSnapshot(doc, numPages.value, localToken);
        if (!pdfSnapshot || localToken !== syncToken) {
            return;
        }

        for (const summary of pdfSnapshot.comments) {
            if (suppressedAnnotationStableKeys.has(summary.stableKey)) {
                continue;
            }
            if (summary.annotationId && suppressedAnnotationIds.has(summary.annotationId)) {
                continue;
            }
            if (summary.annotationId && isDeletedAnnotationElement?.(summary.annotationId)) {
                continue;
            }

            const summaryWithSortIndex: IAnnotationCommentSummary = {
                ...summary,
                sortIndex: sourceOrder,
                kindLabel: resolveAnnotationKindLabel(summary.subtype),
            };
            sourceOrder += 1;

            const normalizedSubtype = (summary.subtype ?? '').trim().toLowerCase();
            if (
                summary.annotationId
                && (normalizedSubtype === 'underline'
                    || normalizedSubtype === 'strikeout'
                    || normalizedSubtype === 'squiggly')
                && isMarkupSubtype(summary.subtype)
            ) {
                markupSubtype.getMarkupSubtypeOverrides().set(summary.annotationId, summary.subtype);
            }

            const hydratedSummary = identity.hydrateSummaryFromMemory(summaryWithSortIndex);
            const summaryKey = identity.toSummaryKey(hydratedSummary);
            const existing = commentsByKey.get(summaryKey);
            if (!existing) {
                commentsByKey.set(summaryKey, hydratedSummary);
                continue;
            }
            commentsByKey.set(
                summaryKey,
                identity.mergeCommentSummaries(existing, hydratedSummary),
            );
        }

        collectedLinks.push(
            ...pdfSnapshot.links.filter((link) => (
                !suppressedAnnotationIds.has(link.id)
                && !isDeletedAnnotationElement?.(link.id)
            )),
        );

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
    }

    async function syncAnnotationComments() {
        syncRerunRequested = true;
        if (syncRunPromise) {
            return syncRunPromise;
        }

        syncRunPromise = (async () => {
            while (syncRerunRequested) {
                syncRerunRequested = false;
                await syncAnnotationCommentsInternal();
            }
        })().finally(() => {
            syncRunPromise = null;
        });

        try {
            await syncRunPromise;
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
        resetPdfAnnotationSnapshot();
    }

    function clearSyncState() {
        syncToken += 1;
        debouncedSync.cancel();
        pendingCommentEditorKeys.clear();
        resetPdfAnnotationSnapshot();
        getIdentity().clearMemory();
        getMarkupSubtype().clearOverrides();
    }

    tryOnScopeDispose(() => {
        debouncedSync.cancel();
        syncToken += 1;
        resetPdfAnnotationSnapshot();
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
        suppressAnnotationStableKey,
        clearSuppressedAnnotationIds,
    };
}
