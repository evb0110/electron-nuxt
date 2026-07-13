// Legacy PDF.js ingestion only. Canonical state remains in AnnotationStore.
import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    tryOnScopeDispose,
    useTimeoutFn,
} from '@vueuse/core';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { detectEditorSubtype } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/detectEditorSubtype';
import { getCommentText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getCommentText';
import { getEditorSelectionPreviewText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getEditorSelectionPreviewText';
import { hasEditorCommentPayload } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/hasEditorCommentPayload';
import { parsePdfDateTimestamp } from '@app/services/pdf/annotationMetadata';
import {
    annotationKindLabelFromSubtype,
    isTextMarkupSubtype,
} from '@app/services/pdf/annotationSubtype';
import { toCssColor } from '@app/modules/pdf-viewer/engine/annotation-css-utils/toCssColor';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { getEditorsOnPage } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import { collectPagePdfSnapshotEntries } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries';
import { loadPdfPageAnnotations } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/loadPdfPageAnnotations';
import { leasePdfDocumentPage } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import { resolveEditorMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveEditorMarkerRect';
import { resolveMarkupSubtypeOverrideRegistration } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveMarkupSubtypeOverrideRegistration';
import { safeReadEditorData } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/safeReadEditorData';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import type { IPdfCommentSummaryDeps } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import type { TComputeSummaryStableKey } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    initialAnnotationSyncState,
    reduceAnnotationSync,
} from '@app/modules/pdf-viewer/annotations/sync/annotationSyncMachine';

interface ISyncIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
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
    resolveEditorSubtypeFromPresentation: (editor: IPdfjsEditor) => TMarkupSubtype | null;
    resolveEditorMarkupSubtypeColor: (editor: IPdfjsEditor, subtype: TMarkupSubtype, pageIndex: number) => string;
    rememberMarkupSubtypeColorOverride: (annotationId: string | null | undefined, color: string | null | undefined) => void;
    syncMarkupSubtypePresentationForEditors: () => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    forgetMarkupSubtypeOverride: (annotationId: string | null | undefined) => void;
    clearOverrides: () => void;
}

interface ISyncStore {
    setAnnotations: (
        comments: IAnnotationCommentSummary[],
        options?: {
            adoptAsSavedBaseline?: boolean;
            reconcileMissingTransient?: boolean;
        },
    ) => IAnnotationCommentSummary[] | undefined;
    setLinkAnnotations: (links: ILinkAnnotation[]) => void;
    setActiveKey: (key: string | null) => void;
}

interface IUseAnnotationSyncOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    documentIdentity: Ref<string>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    authorName: Ref<string | null | undefined>;
    getIdentity: () => ISyncIdentity;
    getMarkupSubtype: () => ISyncMarkupSubtype;
    getStore: () => ISyncStore;
    syncInlineCommentIndicators: () => void;
    debounceMs?: number;
    shouldCollectPdfAnnotationNames?: (() => boolean) | undefined;
}

interface IPdfAnnotationSnapshot {
    doc: PDFDocumentProxy;
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
}

interface ISharedPdfAnnotationSnapshot {
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
}

const MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS = 8;
const sharedPdfAnnotationSnapshots = new Map<string, ISharedPdfAnnotationSnapshot>();
const sourcePdfAnnotationSnapshots = new WeakMap<PDFDocumentProxy, ISharedPdfAnnotationSnapshot>();

function cloneSharedSnapshot(
    cached: ISharedPdfAnnotationSnapshot,
    doc: PDFDocumentProxy,
): IPdfAnnotationSnapshot {
    return {
        doc,
        pageCount: cached.pageCount,
        comments: structuredClone(cached.comments),
        links: structuredClone(cached.links),
    };
}

function rememberSharedSnapshot(key: string, snapshot: IPdfAnnotationSnapshot) {
    sharedPdfAnnotationSnapshots.delete(key);
    sharedPdfAnnotationSnapshots.set(key, {
        pageCount: snapshot.pageCount,
        comments: structuredClone(snapshot.comments),
        links: structuredClone(snapshot.links),
    });
    while (sharedPdfAnnotationSnapshots.size > MAX_SHARED_PDF_ANNOTATION_SNAPSHOTS) {
        const oldestKey = sharedPdfAnnotationSnapshots.keys().next().value;
        if (!oldestKey) break;
        sharedPdfAnnotationSnapshots.delete(oldestKey);
    }
}

type TEditorData = ReturnType<typeof safeReadEditorData>;

export const useAnnotationSync = (options: IUseAnnotationSyncOptions) => {
    const { t } = useTypedI18n();

    const {
        pdfDocument,
        documentIdentity,
        documentRevisionToken,
        numPages,
        currentPage,
        annotationUiManager,
        authorName,
        getIdentity,
        getMarkupSubtype,
        getStore,
        syncInlineCommentIndicators,
        debounceMs = 140,
        shouldCollectPdfAnnotationNames,
    } = options;

    let syncToken = 0;
    let syncRunPromise: Promise<void> | null = null;
    let syncRerunRequested = false;
    const trackedCreatedEditors = new WeakSet<object>();
    let pdfAnnotationSnapshot: IPdfAnnotationSnapshot | null = null;
    let pdfAnnotationSnapshotVersion = 0;
    let pdfAnnotationSnapshotPromise: {
        doc: PDFDocumentProxy;
        pageCount: number;
        version: number;
        promise: Promise<IPdfAnnotationSnapshot | null>;
    } | null = null;
    let syncMachineState = initialAnnotationSyncState<IAnnotationCommentSummary>();
    let hasAppliedDocumentSnapshot = false;

    function getSharedSnapshotKey(pageCount: number) {
        const revision = documentRevisionToken?.value ?? null;
        const identity = documentIdentity.value;
        if (revision) {
            return JSON.stringify([
                'revision',
                revision,
                pageCount,
            ]);
        }
        // A path/name/length tuple is not a content revision: a save can
        // replace bytes in place. Without a revision token the exact PDF.js
        // proxy WeakMap below is the only safe reusable source identity.
        void identity;
        return null;
    }

    function getVisibleFirstPageOrder(pageCount: number) {
        const visiblePage = Math.min(pageCount, Math.max(1, Math.trunc(currentPage.value)));
        return Array.from({length: pageCount}, (_, index) => index + 1)
            .sort((left, right) => Math.abs(left - visiblePage) - Math.abs(right - visiblePage));
    }

    function waitForAnnotationSyncIdleOpportunity() {
        if (typeof window === 'undefined') {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            if (typeof window.requestIdleCallback === 'function') {
                // This inventory is enrichment, never visible-render work.
                // A generous timeout keeps it moving in a truly idle window
                // without letting hundreds of page parses monopolize the UI
                // thread while another document is opening.
                window.requestIdleCallback(() => resolve(), {timeout: 250});
                return;
            }
            setTimeout(resolve, 0);
        });
    }

    function summarizeCommentForTrace(comment: IAnnotationCommentSummary) {
        return {
            annotationId: comment.annotationId,
            displayText: comment.displayText,
            pageNumber: comment.pageNumber,
            previewText: comment.previewText,
            source: comment.source,
            stableKey: comment.stableKey,
            subtype: comment.subtype,
            text: comment.text,
            uid: comment.uid,
        };
    }

    function summarizeCommentsForTrace(comments: IAnnotationCommentSummary[]) {
        const bySource: Record<string, number> = {};
        const bySubtype: Record<string, number> = {};
        comments.forEach((comment) => {
            bySource[comment.source] = (bySource[comment.source] ?? 0) + 1;
            const subtype = comment.subtype ?? 'none';
            bySubtype[subtype] = (bySubtype[subtype] ?? 0) + 1;
        });

        return {
            bySource,
            bySubtype,
            sample: comments.slice(0, 8).map(summarizeCommentForTrace),
            total: comments.length,
        };
    }

    function resetPdfAnnotationSnapshot() {
        pdfAnnotationSnapshotVersion += 1;
        pdfAnnotationSnapshot = null;
        pdfAnnotationSnapshotPromise = null;
    }

    function resolveAnnotationKindLabel(subtype: string | null | undefined) {
        const { key } = annotationKindLabelFromSubtype(subtype);
        return t(key);
    }

    watch(pdfDocument, () => {
        // Abort an inventory tied to the previous PDF proxy immediately. A
        // new document can otherwise spend seconds competing with a stale
        // all-page scan before its first canvas appears.
        syncToken += 1;
        resetPdfAnnotationSnapshot();
        hasAppliedDocumentSnapshot = false;
    });
    watch(documentIdentity, () => {
        syncToken += 1;
        hasAppliedDocumentSnapshot = false;
    });
    watch(() => documentRevisionToken?.value ?? null, () => {
        syncToken += 1;
        resetPdfAnnotationSnapshot();
        hasAppliedDocumentSnapshot = false;
    });

    function rememberResolvedMarkupSubtypeOverride(
        annotationId: string | null,
        resolvedSubtype: string | null | undefined,
        color: string | null | undefined,
        markupSubtype: ISyncMarkupSubtype,
    ) {
        const overrideRegistration = resolveMarkupSubtypeOverrideRegistration(annotationId, resolvedSubtype);
        if (!overrideRegistration) {
            markupSubtype.forgetMarkupSubtypeOverride(annotationId);
            return;
        }
        markupSubtype.rememberMarkupSubtypeColorOverride(annotationId, color);
        markupSubtype.getMarkupSubtypeOverrides().set(
            overrideRegistration.annotationId,
            overrideRegistration.subtype,
        );
    }

    function logPendingAnchorSummary(
        pageIndex: number,
        id: string,
        uid: string | null,
        annotationId: string | null,
        resolvedSubtype: string | null | undefined,
        hasNote: boolean,
        text: string,
        rectResult: ReturnType<typeof resolveEditorMarkerRect>,
    ) {
        if (!rectResult.shouldUsePendingAnchor) {
            return;
        }

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

    function resolveEditorSummaryText(editor: IPdfjsEditor, textOverride?: string) {
        return typeof textOverride === 'string'
            ? textOverride
            : getCommentText(editor);
    }

    function resolveEditorSummaryPreviewText(editor: IPdfjsEditor, text: string) {
        const previewText = getEditorSelectionPreviewText(editor);
        if (!previewText || previewText === text.trim()) {
            return null;
        }
        return previewText;
    }

    function resolveEditorSummarySubtype(
        editor: IPdfjsEditor,
        pageIndex: number,
        markupSubtype: ISyncMarkupSubtype,
    ) {
        return markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex)
            ?? markupSubtype.resolveEditorSubtypeFromPresentation(editor)
            ?? detectEditorSubtype(editor);
    }

    function resolveEditorSummaryHasNote(editor: IPdfjsEditor) {
        return hasEditorCommentPayload(editor);
    }

    function resolveEditorSummaryModifiedAt(data: TEditorData) {
        return parsePdfDateTimestamp(data.modificationDate)
            ?? parsePdfDateTimestamp(data.creationDate);
    }

    function resolveEditorSummaryCreatedAt(data: TEditorData) {
        return parsePdfDateTimestamp(data.creationDate)
            ?? parsePdfDateTimestamp(data.modificationDate);
    }

    function resolveEditorSummaryColor(
        editor: IPdfjsEditor,
        data: TEditorData,
        pageIndex: number,
        subtype: string | null,
        markupSubtype: ISyncMarkupSubtype,
    ) {
        if (isTextMarkupSubtype(subtype)) {
            return markupSubtype.resolveEditorMarkupSubtypeColor(editor, subtype as TMarkupSubtype, pageIndex);
        }
        return toCssColor(
            data.color ?? editor.color,
            data.opacity ?? editor.opacity ?? 1,
        );
    }

    function resolveEditorSummaryAuthor() {
        const author = authorName.value?.trim();
        return author && author.length > 0 ? author : null;
    }

    function toEditorSummary(
        editor: IPdfjsEditor,
        pageIndex: number,
        textOverride?: string,
        sortIndex: number | null = null,
    ): IAnnotationCommentSummary {
        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();

        const data = safeReadEditorData(editor);

        const text = resolveEditorSummaryText(editor, textOverride);
        const previewText = resolveEditorSummaryPreviewText(editor, text);
        const displayText = !text.trim() && previewText ? previewText : null;

        const resolvedSubtype = resolveEditorSummarySubtype(editor, pageIndex, markupSubtype);

        const uid = editor.uid ?? null;
        const annotationId = editor.annotationElementId ?? null;
        const color = resolveEditorSummaryColor(editor, data, pageIndex, resolvedSubtype, markupSubtype);

        rememberResolvedMarkupSubtypeOverride(
            annotationId,
            resolvedSubtype,
            color,
            markupSubtype,
        );

        const id = identity.getEditorIdentity(editor, pageIndex);
        const hasNote = resolveEditorSummaryHasNote(editor);

        const rectResult = resolveEditorMarkerRect(editor);
        logPendingAnchorSummary(pageIndex, id, uid, annotationId, resolvedSubtype, hasNote, text, rectResult);

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
            displayText,
            previewText,
            kindLabel: resolveAnnotationKindLabel(resolvedSubtype),
            subtype: resolvedSubtype,
            author: resolveEditorSummaryAuthor(),
            createdAt: resolveEditorSummaryCreatedAt(data),
            modifiedAt: resolveEditorSummaryModifiedAt(data),
            color,
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
        const { collectPdfAnnotationNamesByPage } = await import(
            '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage'
        );
        const annotationNamesByPage = await collectPdfAnnotationNamesByPage(
            doc,
            { allowFullRead: shouldCollectPdfAnnotationNames?.() ?? true },
        ).catch((error: unknown) => {
            BrowserLogger.debug(
                'annotations',
                'Failed to collect PDF annotation names',
                error,
            );
            return null;
        });

        const pageOrder = getVisibleFirstPageOrder(pageCount);
        let completedPages = 0;
        tracePdfAnnotationSaveEvent('annotation-sync:inventory-start', {
            pageCount,
            firstPage: pageOrder[0] ?? null,
            generation: localToken,
        });
        for (const [
            orderIndex,
            pageNumber,
        ] of pageOrder.entries()) {
            if (localToken !== syncToken) {
                tracePdfAnnotationSaveEvent('annotation-sync:inventory-cancelled', {
                    completedPages,
                    pageCount,
                    generation: localToken,
                });
                return null;
            }

            if (orderIndex > 0) {
                await waitForAnnotationSyncIdleOpportunity();
                if (localToken !== syncToken) {
                    tracePdfAnnotationSaveEvent('annotation-sync:inventory-cancelled', {
                        completedPages,
                        pageCount,
                        generation: localToken,
                    });
                    return null;
                }
            }

            const pageBundle = await loadPdfPageAnnotations(
                doc,
                pageNumber,
                annotationNamesByPage?.get(pageNumber - 1),
                {leasePage: (pdf, page) => leasePdfDocumentPage(
                    pdf,
                    page,
                    'transient-background',
                )},
            );
            if (!pageBundle) {
                completedPages += 1;
                continue;
            }

            collectPagePdfSnapshotEntries(
                pageBundle,
                pageNumber,
                summaryDeps,
                comments,
                links,
            );
            completedPages += 1;
        }

        tracePdfAnnotationSaveEvent('annotation-sync:inventory-complete', {
            completedPages,
            pageCount,
            commentCount: comments.length,
            linkCount: links.length,
            generation: localToken,
        });

        return {
            doc,
            pageCount,
            comments,
            links,
        };
    }

    function matchesPdfSnapshotRequest(
        snapshot: Pick<IPdfAnnotationSnapshot, 'doc' | 'pageCount'>,
        doc: PDFDocumentProxy,
        pageCount: number,
    ) {
        return snapshot.doc === doc && snapshot.pageCount === pageCount;
    }

    function getReusablePdfSnapshotPromise(
        doc: PDFDocumentProxy,
        pageCount: number,
    ) {
        if (
            !pdfAnnotationSnapshotPromise
            || !matchesPdfSnapshotRequest(pdfAnnotationSnapshotPromise, doc, pageCount)
            || pdfAnnotationSnapshotPromise.version !== pdfAnnotationSnapshotVersion
        ) {
            return null;
        }

        return pdfAnnotationSnapshotPromise.promise;
    }

    function shouldCachePdfAnnotationSnapshot(
        snapshot: IPdfAnnotationSnapshot | null,
        doc: PDFDocumentProxy,
        pageCount: number,
        snapshotVersion: number,
    ): snapshot is IPdfAnnotationSnapshot {
        return Boolean(
            snapshot
            && snapshotVersion === pdfAnnotationSnapshotVersion
            && pdfDocument.value === doc
            && numPages.value === pageCount,
        );
    }

    async function getPdfAnnotationSnapshot(
        doc: PDFDocumentProxy,
        pageCount: number,
        localToken: number,
    ): Promise<IPdfAnnotationSnapshot | null> {
        if (pdfAnnotationSnapshot && matchesPdfSnapshotRequest(pdfAnnotationSnapshot, doc, pageCount)) {
            return pdfAnnotationSnapshot;
        }

        const sharedKey = getSharedSnapshotKey(pageCount);
        const shared = (sharedKey ? sharedPdfAnnotationSnapshots.get(sharedKey) : null)
            ?? sourcePdfAnnotationSnapshots.get(doc)
            ?? null;
        if (shared && shared.pageCount === pageCount) {
            // Refresh LRU order and hand each viewer an isolated payload.
            if (sharedKey) {
                sharedPdfAnnotationSnapshots.delete(sharedKey);
                sharedPdfAnnotationSnapshots.set(sharedKey, shared);
            }
            pdfAnnotationSnapshot = cloneSharedSnapshot(shared, doc);
            return pdfAnnotationSnapshot;
        }

        const reusablePromise = getReusablePdfSnapshotPromise(doc, pageCount);
        if (reusablePromise) {
            return reusablePromise;
        }

        const snapshotVersion = pdfAnnotationSnapshotVersion;
        const snapshotPromise = collectPdfAnnotationSnapshot(doc, pageCount, localToken)
            .then((snapshot) => {
                if (shouldCachePdfAnnotationSnapshot(snapshot, doc, pageCount, snapshotVersion)) {
                    pdfAnnotationSnapshot = snapshot;
                    if (sharedKey) {
                        rememberSharedSnapshot(sharedKey, snapshot);
                    }
                    sourcePdfAnnotationSnapshots.set(doc, {
                        pageCount: snapshot.pageCount,
                        comments: structuredClone(snapshot.comments),
                        links: structuredClone(snapshot.links),
                    });
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

    function applyEmptyAnnotationSyncState(
        identity: ISyncIdentity,
        markupSubtype: ISyncMarkupSubtype,
        store: ISyncStore,
    ) {
        tracePdfAnnotationSaveEvent('annotation-sync:empty-state');
        identity.clearMemory();
        markupSubtype.clearOverrides();
        store.setAnnotations([], {reconcileMissingTransient: false});
        store.setLinkAnnotations([]);
        syncInlineCommentIndicators();
    }

    function resolveDeletedAnnotationElementPredicate(
        uiManager: AnnotationEditorUIManager | null,
    ): ((id: string) => boolean) | null {
        if (!uiManager) {
            return null;
        }

        const isDeletedFn = getOptionalFunction<[annotationElementId: string], boolean>(
            uiManager,
            'isDeletedAnnotationElement',
        );
        return isDeletedFn
            ? (id: string) => isDeletedFn.call(uiManager, id)
            : null;
    }

    function collectEditorCommentSummaries(
        identity: ISyncIdentity,
        uiManager: AnnotationEditorUIManager | null,
        commentsByKey: Map<string, IAnnotationCommentSummary>,
    ) {
        let sourceOrder = 0;
        let hasPostOpenUserMutation = false;
        if (!uiManager) {
            tracePdfAnnotationSaveEvent('annotation-sync:collected-editors', {
                count: 0,
                hasUiManager: false,
            });
            return {
                sourceOrder,
                hasPostOpenUserMutation,
            };
        }

        const collected: IAnnotationCommentSummary[] = [];
        let skipped = 0;
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
                hasPostOpenUserMutation ||= trackedCreatedEditors.has(editor);
                const text = getCommentText(editor);
                const summary = toEditorSummary(editor, pageIndex, text, sourceOrder);
                sourceOrder += 1;
                if (shouldSkipEditorCommentSummary(summary)) {
                    skipped += 1;
                    continue;
                }
                const hydrated = identity.hydrateSummaryFromMemory(summary);
                commentsByKey.set(identity.toSummaryKey(hydrated), hydrated);
                collected.push(hydrated);
            }
        }

        tracePdfAnnotationSaveEvent('annotation-sync:collected-editors', () => ({
            skipped,
            ...summarizeCommentsForTrace(collected),
        }));
        return {
            sourceOrder,
            hasPostOpenUserMutation,
        };
    }

    function shouldSkipPdfCommentSummary(
        summary: IAnnotationCommentSummary,
        isDeletedAnnotationElement: ((id: string) => boolean) | null,
    ) {
        return Boolean(summary.annotationId && isDeletedAnnotationElement?.(summary.annotationId));
    }

    function bindReplacedEditorToPdfIdentity(
        identity: ISyncIdentity,
        commentsByKey: Map<string, IAnnotationCommentSummary>,
        summary: IAnnotationCommentSummary,
    ) {
        const candidates = Array.from(commentsByKey.entries()).filter(([
            ,
            candidate,
        ]) => (
            candidate.source === 'editor'
            && candidate.pageIndex === summary.pageIndex
            && (
                candidate.subtype === summary.subtype
                || (
                    isTextMarkupSubtype(candidate.subtype)
                    && isTextMarkupSubtype(summary.subtype)
                )
            )
        ));
        if (candidates.length !== 1) {
            return false;
        }
        const [
            previousKey,
            candidate,
        ] = candidates[0]!;
        commentsByKey.delete(previousKey);
        const annotationName = summary.annotationName ?? candidate.annotationName;
        const annotationId = summary.annotationId ?? candidate.annotationId;
        const bound: IAnnotationCommentSummary = {
            ...candidate,
            ...(annotationName ? {
                annotationName,
                appAnnotationId: annotationName,
            } : {}),
            annotationId,
            stableKey: identity.computeSummaryStableKey({
                id: candidate.id,
                pageIndex: candidate.pageIndex,
                source: candidate.source,
                uid: candidate.uid,
                annotationId,
                annotationName: annotationName ?? null,
            }),
        };
        commentsByKey.set(identity.toSummaryKey(bound), bound);
        return true;
    }

    function shouldSkipEditorCommentSummary(_summary: IAnnotationCommentSummary) {
        return false;
    }

    function rememberMarkupSubtypeOverride(
        summary: IAnnotationCommentSummary,
        markupSubtype: ISyncMarkupSubtype,
    ) {
        rememberResolvedMarkupSubtypeOverride(
            summary.annotationId,
            summary.subtype,
            summary.color,
            markupSubtype,
        );
    }

    function rememberMarkupSubtypeOverrides(
        comments: IAnnotationCommentSummary[],
        markupSubtype: ISyncMarkupSubtype,
    ) {
        comments.forEach(comment => rememberMarkupSubtypeOverride(comment, markupSubtype));
    }

    function mergeHydratedSummary(
        identity: ISyncIdentity,
        commentsByKey: Map<string, IAnnotationCommentSummary>,
        summary: IAnnotationCommentSummary,
    ) {
        const hydratedSummary = identity.hydrateSummaryFromMemory(summary);
        const summaryKey = identity.toSummaryKey(hydratedSummary);
        const existing = commentsByKey.get(summaryKey);
        if (!existing) {
            commentsByKey.set(summaryKey, hydratedSummary);
            return;
        }
        commentsByKey.set(
            summaryKey,
            identity.mergeCommentSummaries(existing, hydratedSummary),
        );
    }

    function mergePdfCommentSummaries(
        identity: ISyncIdentity,
        pdfSnapshot: IPdfAnnotationSnapshot,
        commentsByKey: Map<string, IAnnotationCommentSummary>,
        sourceOrder: number,
        isDeletedAnnotationElement: ((id: string) => boolean) | null,
    ) {
        let nextSourceOrder = sourceOrder;

        for (const summary of pdfSnapshot.comments) {
            if (bindReplacedEditorToPdfIdentity(identity, commentsByKey, summary)) {
                continue;
            }
            if (shouldSkipPdfCommentSummary(summary, isDeletedAnnotationElement)) {
                continue;
            }

            const summaryWithSortIndex: IAnnotationCommentSummary = {
                ...summary,
                sortIndex: nextSourceOrder,
                kindLabel: resolveAnnotationKindLabel(summary.subtype),
            };
            nextSourceOrder += 1;

            mergeHydratedSummary(identity, commentsByKey, summaryWithSortIndex);
        }

        tracePdfAnnotationSaveEvent('annotation-sync:merged-pdf-snapshot', () => ({
            nextSourceOrder,
            pdfSnapshot: summarizeCommentsForTrace(pdfSnapshot.comments),
            visibleCommentsByKey: commentsByKey.size,
        }));
        return nextSourceOrder;
    }

    function collectVisiblePdfLinks(
        pdfSnapshot: IPdfAnnotationSnapshot,
        isDeletedAnnotationElement: ((id: string) => boolean) | null,
    ) {
        return pdfSnapshot.links.filter(link => !isDeletedAnnotationElement?.(link.id));
    }

    function applyAnnotationSyncState(
        identity: ISyncIdentity,
        markupSubtype: ISyncMarkupSubtype,
        store: ISyncStore,
        commentsByKey: Map<string, IAnnotationCommentSummary>,
        links: ILinkAnnotation[],
        editorSnapshotIsAuthoritative: boolean,
        hasPostOpenUserMutation: boolean,
    ) {
        const comments = identity.dedupeAnnotationCommentSummaries(
            Array.from(commentsByKey.values()),
        );
        tracePdfAnnotationSaveEvent('annotation-sync:apply-state', () => ({
            comments: summarizeCommentsForTrace(comments),
            links: links.length,
        }));
        const appliedComments = store.setAnnotations(
            comments,
            {
                adoptAsSavedBaseline: editorSnapshotIsAuthoritative
                    && !hasAppliedDocumentSnapshot
                    && !hasPostOpenUserMutation,
                reconcileMissingTransient: editorSnapshotIsAuthoritative,
            },
        ) ?? comments;
        if (editorSnapshotIsAuthoritative) {
            hasAppliedDocumentSnapshot = true;
        }
        appliedComments.forEach((comment) => {
            identity.rememberSummaryText(comment);
        });
        rememberMarkupSubtypeOverrides(appliedComments, markupSubtype);
        store.setLinkAnnotations(links);
        markupSubtype.syncMarkupSubtypePresentationForEditors();
        syncInlineCommentIndicators();
    }

    async function syncAnnotationCommentsInternal() {
        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();
        const store = getStore();
        const doc = pdfDocument.value;

        if (!doc || numPages.value <= 0) {
            applyEmptyAnnotationSyncState(identity, markupSubtype, store);
            return;
        }

        const localToken = ++syncToken;
        syncMachineState = reduceAnnotationSync(syncMachineState, {
            type: 'begin',
            generation: localToken,
        });
        const commentsByKey = new Map<string, IAnnotationCommentSummary>();
        const uiManager = annotationUiManager.value;
        const isDeletedAnnotationElement = resolveDeletedAnnotationElementPredicate(uiManager);
        const {
            sourceOrder,
            hasPostOpenUserMutation,
        } = collectEditorCommentSummaries(identity, uiManager, commentsByKey);
        syncMachineState = reduceAnnotationSync(syncMachineState, {
            type: 'receive-editor-snapshot',
            generation: localToken,
            records: Array.from(commentsByKey.values()),
        });

        const pdfSnapshot = await getPdfAnnotationSnapshot(doc, numPages.value, localToken);
        if (!pdfSnapshot || localToken !== syncToken) {
            tracePdfAnnotationSaveEvent('annotation-sync:pdf-snapshot-stale', {
                hasSnapshot: Boolean(pdfSnapshot),
                localToken,
                syncToken,
            });
            return;
        }
        tracePdfAnnotationSaveEvent('annotation-sync:pdf-snapshot', () => ({
            comments: summarizeCommentsForTrace(pdfSnapshot.comments),
            links: pdfSnapshot.links.length,
            pageCount: pdfSnapshot.pageCount,
        }));
        const pdfCommentsByPage = new Map<number, IAnnotationCommentSummary[]>();
        pdfSnapshot.comments.forEach((comment) => {
            const records = pdfCommentsByPage.get(comment.pageIndex) ?? [];
            records.push(comment);
            pdfCommentsByPage.set(comment.pageIndex, records);
        });
        pdfCommentsByPage.forEach((records, pageIndex) => {
            syncMachineState = reduceAnnotationSync(syncMachineState, {
                type: 'receive-pdf-page',
                generation: localToken,
                pageIndex,
                records,
            });
        });

        mergePdfCommentSummaries(
            identity,
            pdfSnapshot,
            commentsByKey,
            sourceOrder,
            isDeletedAnnotationElement,
        );
        const collectedLinks = collectVisiblePdfLinks(pdfSnapshot, isDeletedAnnotationElement);

        if (localToken !== syncToken) {
            return;
        }

        syncMachineState = reduceAnnotationSync(syncMachineState, {
            type: 'finish-pdf-snapshot',
            generation: localToken,
        });
        if (syncMachineState.phase !== 'complete') {
            return;
        }

        applyAnnotationSyncState(
            identity,
            markupSubtype,
            store,
            commentsByKey,
            collectedLinks,
            uiManager !== null,
            hasPostOpenUserMutation,
        );
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

    const {
        start: startDebouncedSync,
        stop: cancelDebouncedSync,
    } = useTimeoutFn(() => {
        runGuardedTask(() => syncAnnotationComments(), {
            category: 'background-diagnostic',
            scope: 'annotations',
            message: 'Failed to synchronize annotation comments (debounced)',
        });
    }, debounceMs, { immediate: false });

    function scheduleAnnotationCommentsSync(immediate = false) {
        if (immediate) {
            cancelDebouncedSync();
            runGuardedTask(() => syncAnnotationComments(), {
                category: 'background-diagnostic',
                scope: 'annotations',
                message: 'Failed to synchronize annotation comments',
            });
            return;
        }
        startDebouncedSync();
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
        cancelDebouncedSync();
        resetPdfAnnotationSnapshot();
        hasAppliedDocumentSnapshot = false;
        getIdentity().clearMemory();
        getMarkupSubtype().clearOverrides();
    }

    tryOnScopeDispose(() => {
        cancelDebouncedSync();
        syncToken += 1;
        resetPdfAnnotationSnapshot();
    });

    return {
        trackedCreatedEditors,
        toEditorSummary,
        syncAnnotationComments,
        scheduleAnnotationCommentsSync,
        setActiveCommentStableKey,
        incrementSyncToken,
        clearSyncState,
    };
};
