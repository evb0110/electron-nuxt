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
    IAnnotationInventoryCompleteness,
    ILinkAnnotation,
    TAnnotationInventoryOmission,
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
import { logPendingAnchorSummary } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/logPendingAnchorSummary';
import { createAnnotationSyncAutomationBarrier } from '@app/utils/createAnnotationSyncAutomationBarrier';
import {
    getEditorsOnPage,
    getPdfjsEditorFacadeState,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import { collectPagePdfSnapshotEntries } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries';
import {
    createIncompleteInventoryRetryLedger,
    MAX_BACKGROUND_PDF_ANNOTATION_PAGES,
    MAX_BACKGROUND_PDF_ANNOTATION_RECORDS,
    resolveAnnotationInventoryCompleteness,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationInventoryCompleteness';
import type {
    IPdfAnnotationSnapshot,
    IPdfAnnotationSnapshotFence,
    TPdfAnnotationNameReadResult,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/pdfAnnotationSnapshotCache';
import {
    cloneSharedPdfAnnotationSnapshot,
    readSharedPdfAnnotationSnapshot,
    rememberPdfAnnotationSnapshot,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/pdfAnnotationSnapshotCache';
import { loadPdfPageAnnotations } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/loadPdfPageAnnotations';
import { leasePdfDocumentPage } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    areAnnotationEnrichmentStatesEqual,
    evaluateAnnotationEnrichmentEligibility,
    PENDING_ANNOTATION_ENRICHMENT_STATE,
    resolveAnnotationEnrichmentState,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type {
    IAnnotationEnrichmentLimits,
    IAnnotationEnrichmentRequest,
    IAnnotationEnrichmentState,
    TAnnotationEnrichmentIntent,
    TAnnotationEnrichmentSkipReason,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import { resolveEditorMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveEditorMarkerRect';
import { resolveMarkupSubtypeOverrideRegistration } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveMarkupSubtypeOverrideRegistration';
import { safeReadEditorData } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/safeReadEditorData';
import type { IPdfCommentSummaryDeps } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import type { TComputeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { ITextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';

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
    setInventoryCompleteness: (completeness: IAnnotationInventoryCompleteness | null) => void;
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
    textMarkupPresentation: ITextMarkupPresentationController;
    debounceMs?: number;
    getAnnotationNameReadLimits: () => IAnnotationEnrichmentLimits;
    getPdfSourceByteSize: () => number | null;
    isPdfSourceBlob: () => boolean;
}

type TPdfAnnotationNameReadIntent = TAnnotationEnrichmentIntent;
type TPdfAnnotationNameReconciliationResult =
    | 'reconciled'
    | 'already-reconciled'
    | 'skipped-over-limit'
    | 'stale'
    | 'failed';

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
        textMarkupPresentation,
        debounceMs = 140,
        getAnnotationNameReadLimits,
        getPdfSourceByteSize,
        isPdfSourceBlob,
    } = options;

    const annotationEnrichmentState = ref<IAnnotationEnrichmentState>(PENDING_ANNOTATION_ENRICHMENT_STATE);
    const automationBarrier = createAnnotationSyncAutomationBarrier();
    let syncToken = 0;
    let syncRunPromise: Promise<void> | null = null;
    let syncRerunRequested = false;
    const trackedCreatedEditors = new WeakSet<object>();
    let pdfAnnotationSnapshot: IPdfAnnotationSnapshot | null = null;
    let pdfAnnotationSnapshotVersion = 0;
    const incompleteInventoryRetries = createIncompleteInventoryRetryLedger(
        () => pdfAnnotationSnapshotVersion,
    );
    let pdfAnnotationSnapshotPromise: (IPdfAnnotationSnapshotFence & {
        doc: PDFDocumentProxy;
        version: number;
        intent: TPdfAnnotationNameReadIntent;
        promise: Promise<IPdfAnnotationSnapshot | null>;
    }) | null = null;
    let annotationNameReconciliationPromise: {
        doc: PDFDocumentProxy;
        pageCount: number;
        snapshotVersion: number;
        promise: Promise<TPdfAnnotationNameReconciliationResult>;
    } | null = null;
    let hasAppliedDocumentSnapshot = false;

    function resolvePdfAnnotationSnapshotFence(pageCount: number): IPdfAnnotationSnapshotFence {
        return {
            pageCount,
            identity: documentIdentity.value,
            revision: documentRevisionToken?.value ?? null,
        };
    }

    function getSharedSnapshotKey(pageCount: number) {
        const revision = documentRevisionToken?.value ?? null;
        const identity = documentIdentity.value;
        if (revision) {
            return JSON.stringify([
                'revision',
                identity,
                revision,
                pageCount,
            ]);
        }
        // A path/name/length tuple is not a content revision: a save can
        // replace bytes in place. Without a revision token the exact PDF.js
        // proxy WeakMap below is the only safe reusable source identity.
        return null;
    }

    function* getVisibleFirstPageOrder(pageCount: number) {
        const visiblePage = Math.min(pageCount, Math.max(1, Math.trunc(currentPage.value)));
        yield visiblePage;
        for (let distance = 1; distance < pageCount; distance += 1) {
            const before = visiblePage - distance;
            const after = visiblePage + distance;
            if (before >= 1) yield before;
            if (after <= pageCount) yield after;
            if (before < 1 && after > pageCount) {
                return;
            }
        }
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

    function resolveAnnotationEnrichmentRequest(
        intent: TAnnotationEnrichmentIntent,
        pageCount: number,
    ): IAnnotationEnrichmentRequest {
        return {
            intent,
            pageCount,
            sourceByteSize: getPdfSourceByteSize(),
            isBlobSource: isPdfSourceBlob(),
            limits: getAnnotationNameReadLimits(),
        };
    }

    function setAnnotationEnrichmentState(next: IAnnotationEnrichmentState) {
        if (areAnnotationEnrichmentStatesEqual(annotationEnrichmentState.value, next)) {
            return;
        }
        annotationEnrichmentState.value = next;
    }

    function publishAnnotationEnrichmentState(
        readResult: TPdfAnnotationNameReadResult,
        skipReason: TAnnotationEnrichmentSkipReason | null,
        pageCount: number,
    ) {
        setAnnotationEnrichmentState(resolveAnnotationEnrichmentState(
            readResult,
            skipReason,
            evaluateAnnotationEnrichmentEligibility(
                resolveAnnotationEnrichmentRequest('interactive', pageCount),
            ),
        ));
    }

    function resetPdfAnnotationSnapshot() {
        setAnnotationEnrichmentState(PENDING_ANNOTATION_ENRICHMENT_STATE);
        pdfAnnotationSnapshotVersion += 1;
        pdfAnnotationSnapshot = null;
        pdfAnnotationSnapshotPromise = null;
        annotationNameReconciliationPromise = null;
        incompleteInventoryRetries.reset();
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
        // A new identity is a different document even when PDF.js hands back
        // the same proxy and page count, so nothing read from the previous
        // one may survive.
        syncToken += 1;
        resetPdfAnnotationSnapshot();
        hasAppliedDocumentSnapshot = false;
    });
    watch(() => documentRevisionToken?.value ?? null, () => {
        syncToken += 1;
        resetPdfAnnotationSnapshot();
        hasAppliedDocumentSnapshot = false;
    });

    /**
     * Markup colour is presentation memory this bridge owns; the subtype is not.
     * AnnotationStore holds it, so nothing is copied back here.
     */
    function rememberResolvedMarkupSubtypeColor(
        annotationId: string | null,
        resolvedSubtype: string | null | undefined,
        color: string | null | undefined,
        markupSubtype: ISyncMarkupSubtype,
    ) {
        if (!resolveMarkupSubtypeOverrideRegistration(annotationId, resolvedSubtype)) {
            markupSubtype.forgetMarkupSubtypeOverride(annotationId);
            return;
        }
        markupSubtype.rememberMarkupSubtypeColorOverride(annotationId, color);
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

        rememberResolvedMarkupSubtypeColor(
            annotationId,
            resolvedSubtype,
            color,
            markupSubtype,
        );

        const id = identity.getEditorIdentity(editor, pageIndex);
        const hasNote = resolveEditorSummaryHasNote(editor);

        const rectResult = resolveEditorMarkerRect(editor);
        logPendingAnchorSummary(pageIndex, id, uid, annotationId, resolvedSubtype, hasNote, text, rectResult);

        const canonicalAnnotationId = getPdfjsEditorFacadeState(editor).canonicalAnnotationId;
        return {
            ...(canonicalAnnotationId ? {appAnnotationId: canonicalAnnotationId} : {}),
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
        intent: TPdfAnnotationNameReadIntent,
    ): Promise<IPdfAnnotationSnapshot | null> {
        const fence = resolvePdfAnnotationSnapshotFence(pageCount);
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
        const eligibility = evaluateAnnotationEnrichmentEligibility(
            resolveAnnotationEnrichmentRequest(intent, pageCount),
        );
        const allowFullRead = eligibility.allowed;
        let annotationNameReadResult: TPdfAnnotationNameReadResult = allowFullRead
            ? 'reconciled'
            : 'skipped';
        const annotationNamesByPage = allowFullRead
            ? await collectPdfAnnotationNamesByPage(
                doc,
                {allowFullRead: true},
            ).catch((error: unknown) => {
                BrowserLogger.debug(
                    'annotations',
                    'Failed to collect PDF annotation names',
                    error,
                );
                annotationNameReadResult = 'failed';
                return null;
            })
            : null;

        const pageOrder = getVisibleFirstPageOrder(pageCount);
        // Both caps and every page read failure are omissions. The loop
        // records them instead of ending quietly, because the snapshot they
        // produce is cached and reused far beyond this scan.
        const omissions = new Set<TAnnotationInventoryOmission>();
        let visitedPages = 0;
        let failedPageCount = 0;
        
        let orderIndex = 0;
        for (const pageNumber of pageOrder) {
            // A cap can only trip while pages remain, because the generator
            // stops yielding once the document is exhausted.
            if (visitedPages >= MAX_BACKGROUND_PDF_ANNOTATION_PAGES) {
                omissions.add('page-cap');
                break;
            }
            if (comments.length + links.length >= MAX_BACKGROUND_PDF_ANNOTATION_RECORDS) {
                omissions.add('record-cap');
                break;
            }
            if (localToken !== syncToken) {
                
                return null;
            }

            if (orderIndex > 0) {
                await waitForAnnotationSyncIdleOpportunity();
                if (localToken !== syncToken) {
                    
                    return null;
                }
            }
            orderIndex += 1;

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
            visitedPages += 1;
            if (!pageBundle) {
                failedPageCount += 1;
                omissions.add('page-parse-failure');
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

        const completeness = resolveAnnotationInventoryCompleteness({
            omissions,
            visitedPageCount: visitedPages,
            failedPageCount,
            totalPageCount: pageCount,
        });

        return {
            doc,
            ...fence,
            comments,
            links,
            annotationNameReadResult,
            annotationNameSkipReason: eligibility.reason,
            completeness,
        };
    }

    /**
     * Reuse is fenced on the exact source, not on shape. Page count and PDF.js
     * proxy can both repeat across documents; identity plus revision cannot.
     */
    function matchesPdfSnapshotFence(
        snapshot: IPdfAnnotationSnapshotFence,
        pageCount: number,
    ) {
        return snapshot.pageCount === pageCount
            && snapshot.identity === documentIdentity.value
            && snapshot.revision === (documentRevisionToken?.value ?? null);
    }

    function matchesPdfSnapshotRequest(
        snapshot: IPdfAnnotationSnapshotFence & {doc: PDFDocumentProxy},
        doc: PDFDocumentProxy,
        pageCount: number,
    ) {
        return snapshot.doc === doc && matchesPdfSnapshotFence(snapshot, pageCount);
    }

    function getReusablePdfSnapshotPromise(
        doc: PDFDocumentProxy,
        pageCount: number,
        intent: TPdfAnnotationNameReadIntent,
    ) {
        if (
            !pdfAnnotationSnapshotPromise
            || !matchesPdfSnapshotRequest(pdfAnnotationSnapshotPromise, doc, pageCount)
            || pdfAnnotationSnapshotPromise.version !== pdfAnnotationSnapshotVersion
            || (
                intent === 'interactive'
                && pdfAnnotationSnapshotPromise.intent !== 'interactive'
            )
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
            && numPages.value === pageCount
            && matchesPdfSnapshotFence(snapshot, pageCount),
        );
    }

    async function getPdfAnnotationSnapshot(
        doc: PDFDocumentProxy,
        pageCount: number,
        localToken: number,
        intent: TPdfAnnotationNameReadIntent,
    ): Promise<IPdfAnnotationSnapshot | null> {
        const shouldDiscardIncompleteSnapshot = incompleteInventoryRetries.createGate();
        if (
            pdfAnnotationSnapshot
            && matchesPdfSnapshotRequest(pdfAnnotationSnapshot, doc, pageCount)
            && (
                intent === 'eager'
                || pdfAnnotationSnapshot.annotationNameReadResult === 'reconciled'
            )
            && !shouldDiscardIncompleteSnapshot(pdfAnnotationSnapshot.completeness)
        ) {
            return pdfAnnotationSnapshot;
        }

        const sharedKey = getSharedSnapshotKey(pageCount);
        const shared = readSharedPdfAnnotationSnapshot(sharedKey, doc);
        if (
            shared
            && matchesPdfSnapshotFence(shared, pageCount)
            && (
                intent === 'eager'
                || shared.annotationNameReadResult === 'reconciled'
            )
            && !shouldDiscardIncompleteSnapshot(shared.completeness)
        ) {
            // Hand each viewer an isolated payload.
            pdfAnnotationSnapshot = cloneSharedPdfAnnotationSnapshot(shared, doc);
            return pdfAnnotationSnapshot;
        }

        const reusablePromise = getReusablePdfSnapshotPromise(doc, pageCount, intent);
        if (reusablePromise) {
            return reusablePromise;
        }

        const snapshotVersion = pdfAnnotationSnapshotVersion;
        const snapshotPromise = collectPdfAnnotationSnapshot(doc, pageCount, localToken, intent)
            .then((snapshot) => {
                if (shouldCachePdfAnnotationSnapshot(snapshot, doc, pageCount, snapshotVersion)) {
                    pdfAnnotationSnapshot = snapshot;
                    rememberPdfAnnotationSnapshot(sharedKey, doc, snapshot);
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
            ...resolvePdfAnnotationSnapshotFence(pageCount),
            version: snapshotVersion,
            intent,
            promise: snapshotPromise,
        };

        return snapshotPromise;
    }

    function applyEmptyAnnotationSyncState(
        identity: ISyncIdentity,
        markupSubtype: ISyncMarkupSubtype,
        store: ISyncStore,
    ) {
        setAnnotationEnrichmentState(PENDING_ANNOTATION_ENRICHMENT_STATE);
        identity.clearMemory();
        markupSubtype.clearOverrides();
        store.setAnnotations([], {reconcileMissingTransient: false});
        store.setLinkAnnotations([]);
        store.setInventoryCompleteness(null);
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
            
            return {
                sourceOrder,
                hasPostOpenUserMutation,
            };
        }

        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
                hasPostOpenUserMutation ||= trackedCreatedEditors.has(editor);
                const text = getCommentText(editor);
                const summary = toEditorSummary(editor, pageIndex, text, sourceOrder);
                sourceOrder += 1;
                if (shouldSkipEditorCommentSummary(summary)) {
                    continue;
                }
                const hydrated = identity.hydrateSummaryFromMemory(summary);
                commentsByKey.set(identity.toSummaryKey(hydrated), hydrated);
            }
        }

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

    function rememberMarkupSubtypeColors(
        comments: IAnnotationCommentSummary[],
        markupSubtype: ISyncMarkupSubtype,
    ) {
        comments.forEach(comment => rememberResolvedMarkupSubtypeColor(
            comment.annotationId,
            comment.subtype,
            comment.color,
            markupSubtype,
        ));
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
        completeness: IAnnotationInventoryCompleteness,
    ) {
        const comments = identity.dedupeAnnotationCommentSummaries(
            Array.from(commentsByKey.values()),
        );
        
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
        rememberMarkupSubtypeColors(appliedComments, markupSubtype);
        store.setLinkAnnotations(links);
        store.setInventoryCompleteness(completeness);
        textMarkupPresentation.notify({kind: 'editors-changed'});
        syncInlineCommentIndicators();
    }

    async function syncAnnotationCommentsInternal(
        annotationNameReadIntent: TPdfAnnotationNameReadIntent = 'eager',
    ) {
        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();
        const store = getStore();
        const doc = pdfDocument.value;

        if (!doc || numPages.value <= 0) {
            applyEmptyAnnotationSyncState(identity, markupSubtype, store);
            return null;
        }

        if (annotationNameReadIntent === 'interactive') {
            // A read that is running is neither a completed skip nor a
            // failure. The annotations panel starts this pass the moment it
            // opens, so leaving the previous verdict up would tell the user
            // the read was declined at the exact moment it is happening, and
            // would offer a retry that only restarts the pass already going.
            setAnnotationEnrichmentState(PENDING_ANNOTATION_ENRICHMENT_STATE);
        }

        const localToken = ++syncToken;
        const commentsByKey = new Map<string, IAnnotationCommentSummary>();
        const uiManager = annotationUiManager.value;
        const isDeletedAnnotationElement = resolveDeletedAnnotationElementPredicate(uiManager);
        const {
            sourceOrder,
            hasPostOpenUserMutation,
        } = collectEditorCommentSummaries(identity, uiManager, commentsByKey);

        const pdfSnapshot = await getPdfAnnotationSnapshot(
            doc,
            numPages.value,
            localToken,
            annotationNameReadIntent,
        );
        if (!pdfSnapshot || localToken !== syncToken) {
            
            return null;
        }
        
        mergePdfCommentSummaries(
            identity,
            pdfSnapshot,
            commentsByKey,
            sourceOrder,
            isDeletedAnnotationElement,
        );
        const collectedLinks = collectVisiblePdfLinks(pdfSnapshot, isDeletedAnnotationElement);

        if (localToken !== syncToken) {
            return null;
        }

        applyAnnotationSyncState(
            identity,
            markupSubtype,
            store,
            commentsByKey,
            collectedLinks,
            uiManager !== null,
            hasPostOpenUserMutation,
            pdfSnapshot.completeness,
        );
        publishAnnotationEnrichmentState(
            pdfSnapshot.annotationNameReadResult,
            pdfSnapshot.annotationNameSkipReason,
            pdfSnapshot.pageCount,
        );
        return pdfSnapshot;
    }

    function ensurePdfAnnotationNameReconciliation(
        reason: 'annotations-ui-open' | 'existing-annotation-mutation',
    ): Promise<TPdfAnnotationNameReconciliationResult> {
        const doc = pdfDocument.value;
        const pageCount = numPages.value;
        if (!doc || pageCount <= 0) {
            return Promise.resolve('stale');
        }
        if (
            pdfAnnotationSnapshot
            && matchesPdfSnapshotRequest(pdfAnnotationSnapshot, doc, pageCount)
            && pdfAnnotationSnapshot.annotationNameReadResult === 'reconciled'
            && !incompleteInventoryRetries.hasPendingRetry(pdfAnnotationSnapshot.completeness)
        ) {
            return Promise.resolve('already-reconciled');
        }

        const interactiveEligibility = evaluateAnnotationEnrichmentEligibility(
            resolveAnnotationEnrichmentRequest('interactive', pageCount),
        );
        if (!interactiveEligibility.allowed) {
            publishAnnotationEnrichmentState('skipped', interactiveEligibility.reason, pageCount);
            return Promise.resolve('skipped-over-limit');
        }

        const snapshotVersion = pdfAnnotationSnapshotVersion;
        if (
            annotationNameReconciliationPromise
            && annotationNameReconciliationPromise.doc === doc
            && annotationNameReconciliationPromise.pageCount === pageCount
            && annotationNameReconciliationPromise.snapshotVersion === snapshotVersion
        ) {
            return annotationNameReconciliationPromise.promise;
        }

        
        const promise = automationBarrier.trackPass(() => syncAnnotationCommentsInternal('interactive'))
            .then((snapshot): TPdfAnnotationNameReconciliationResult => {
                if (
                    pdfDocument.value !== doc
                    || numPages.value !== pageCount
                    || pdfAnnotationSnapshotVersion !== snapshotVersion
                ) {
                    return 'stale';
                }
                if (!snapshot) {
                    return 'stale';
                }
                return snapshot.annotationNameReadResult === 'reconciled'
                    ? 'reconciled'
                    : snapshot.annotationNameReadResult === 'failed'
                        ? 'failed'
                        : 'skipped-over-limit';
            })
            .catch((error: unknown) => {
                BrowserLogger.warn('annotations', 'Annotation-name reconciliation failed', {
                    error,
                    reason,
                });
                if (
                    pdfDocument.value === doc
                    && numPages.value === pageCount
                    && pdfAnnotationSnapshotVersion === snapshotVersion
                ) {
                    publishAnnotationEnrichmentState('failed', null, pageCount);
                }
                return 'failed' as const;
            })
            .finally(() => {
                if (annotationNameReconciliationPromise?.promise === promise) {
                    annotationNameReconciliationPromise = null;
                }
            });
        annotationNameReconciliationPromise = {
            doc,
            pageCount,
            snapshotVersion,
            promise,
        };
        return promise;
    }

    async function syncAnnotationComments() {
        automationBarrier.noteRequested();
        syncRerunRequested = true;
        if (syncRunPromise) {
            return syncRunPromise;
        }

        syncRunPromise = (async () => {
            while (syncRerunRequested) {
                syncRerunRequested = false;
                const servicedSeq = automationBarrier.readRequestSeq();
                await automationBarrier.trackPass(() => syncAnnotationCommentsInternal());
                automationBarrier.noteServiced(servicedSeq);
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
        start: startDebouncedSyncTimer,
        stop: stopDebouncedSyncTimer,
    } = useTimeoutFn(() => {
        automationBarrier.releaseDebounce();
        runGuardedTask(() => syncAnnotationComments(), {
            category: 'background-diagnostic',
            scope: 'annotations',
            message: 'Failed to synchronize annotation comments (debounced)',
        });
    }, debounceMs, { immediate: false });

    function startDebouncedSync() {
        automationBarrier.noteRequested();
        automationBarrier.armDebounce();
        startDebouncedSyncTimer();
    }

    function cancelDebouncedSync() {
        automationBarrier.releaseDebounce();
        stopDebouncedSyncTimer();
    }

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

    /**
     * Retires any sync whose editor scan predates this call. A sync reads the
     * editor layer synchronously and then awaits the PDF snapshot; an
     * annotation history replay landing inside that await moves canonical
     * entities and PDF.js editors together, so the collected scan describes a
     * layer that no longer exists and must not be applied over the replay. The
     * parsed PDF snapshot is kept: a replay changes editors, not the document
     * bytes those pages were parsed from.
     *
     * A snapshot collection that is still running is fenced by the same token
     * and now resolves `null`, so its registration is retired too. Leaving it
     * behind would hand that `null` to the post-replay resync as a reusable
     * result and end the pass before it applies anything. A snapshot that
     * already finished stays cached: it is document bytes, which the replay
     * did not touch.
     */
    function discardInFlightSync() {
        syncToken += 1;
        pdfAnnotationSnapshotPromise = null;
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
        annotationEnrichmentState: readonly(annotationEnrichmentState),
        trackedCreatedEditors,
        toEditorSummary,
        syncAnnotationComments,
        scheduleAnnotationCommentsSync,
        discardInFlightSync,
        ensurePdfAnnotationNameReconciliation,
        setActiveCommentStableKey,
        incrementSyncToken,
        clearSyncState,
    };
};
