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
    setAnnotations: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary[] | undefined;
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
    shouldCollectPdfAnnotationNames?: (() => boolean) | undefined;
}

interface IPdfAnnotationSnapshot {
    doc: PDFDocumentProxy;
    pageCount: number;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
}

type TEditorData = ReturnType<typeof safeReadEditorData>;

export const useAnnotationSync = (options: IUseAnnotationSyncOptions) => {
    const { t } = useTypedI18n();

    const {
        pdfDocument,
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
                window.requestIdleCallback(() => resolve(), {timeout: 50});
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
        resetPdfAnnotationSnapshot();
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
        for (const [
            orderIndex,
            pageNumber,
        ] of pageOrder.entries()) {
            if (localToken !== syncToken) {
                return null;
            }

            if (orderIndex > 0 && orderIndex % 4 === 0) {
                await waitForAnnotationSyncIdleOpportunity();
            }

            const pageBundle = await loadPdfPageAnnotations(
                doc,
                pageNumber,
                annotationNamesByPage?.get(pageNumber - 1),
                {leasePage: leasePdfDocumentPage},
            );
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

        const reusablePromise = getReusablePdfSnapshotPromise(doc, pageCount);
        if (reusablePromise) {
            return reusablePromise;
        }

        const snapshotVersion = pdfAnnotationSnapshotVersion;
        const snapshotPromise = collectPdfAnnotationSnapshot(doc, pageCount, localToken)
            .then((snapshot) => {
                if (shouldCachePdfAnnotationSnapshot(snapshot, doc, pageCount, snapshotVersion)) {
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

    function applyEmptyAnnotationSyncState(
        identity: ISyncIdentity,
        markupSubtype: ISyncMarkupSubtype,
        store: ISyncStore,
    ) {
        tracePdfAnnotationSaveEvent('annotation-sync:empty-state');
        identity.clearMemory();
        markupSubtype.clearOverrides();
        store.setAnnotations([]);
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
        if (!uiManager) {
            tracePdfAnnotationSaveEvent('annotation-sync:collected-editors', {
                count: 0,
                hasUiManager: false,
            });
            return sourceOrder;
        }

        const collected: IAnnotationCommentSummary[] = [];
        let skipped = 0;
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
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
        return sourceOrder;
    }

    function shouldSkipPdfCommentSummary(
        summary: IAnnotationCommentSummary,
        isDeletedAnnotationElement: ((id: string) => boolean) | null,
    ) {
        return Boolean(summary.annotationId && isDeletedAnnotationElement?.(summary.annotationId));
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
    ) {
        const comments = identity.dedupeAnnotationCommentSummaries(
            Array.from(commentsByKey.values()),
        );
        tracePdfAnnotationSaveEvent('annotation-sync:apply-state', () => ({
            comments: summarizeCommentsForTrace(comments),
            links: links.length,
        }));
        const appliedComments = store.setAnnotations(comments) ?? comments;
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
        const sourceOrder = collectEditorCommentSummaries(identity, uiManager, commentsByKey);
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

        applyAnnotationSyncState(identity, markupSubtype, store, commentsByKey, collectedLinks);
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
