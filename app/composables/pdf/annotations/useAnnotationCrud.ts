import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    useTimeoutFn,
    tryOnScopeDispose,
} from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/annotations/types';
import {
    isNoteEligibleComment,
    markerRectCenterDistance,
} from '@app/composables/pdf/annotations/types';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    getCommentText,
    hasEditorCommentPayload,
    normalizeMarkerRect,
    markerRectIoU,
    toMarkerRectFromEditor,
    escapeCssAttr,
    errorToLogText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentCandidateIds,
    findEditorForComment as findEditorForCommentHelper,
    findEditorByAnnotationElementId as findEditorByAnnotationElementIdHelper,
    findEditorFromTarget as findEditorFromTargetHelper,
    findPdfAnnotationSummaryFromTarget,
    findAnnotationSummaryFromPoint as findAnnotationSummaryFromPointHelper,
} from '@app/composables/pdf/annotationCommentCrudHelpers';
import type { IEditorTargetMatch } from '@app/composables/pdf/annotationCommentCrudHelpers';
import { runGuardedTask } from '@app/utils/async-guard';
import {
    getEditorById,
    getEditorByUidFromLayer,
    selectCommentByUid,
    setSelectedEditor,
    unselectAllEditors,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';

export type { IEditorTargetMatch } from '@app/composables/pdf/annotationCommentCrudHelpers';
export {
    getCommentCandidateIds,
    findPdfAnnotationSummaryFromTarget,
} from '@app/composables/pdf/annotationCommentCrudHelpers';

interface ICrudIdentity {
    resolveCommentFromCache: (comment: IAnnotationCommentSummary) => IAnnotationCommentSummary | null;
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
    hydrateSummaryFromMemory: (summary: IAnnotationCommentSummary) => IAnnotationCommentSummary;
    computeSummaryStableKey: (params: {
        id: string;
        pageIndex: number;
        source: 'editor' | 'pdf';
        uid?: string;
        annotationId?: string | null;
    }) => string;
    rememberSummaryText: (summary: IAnnotationCommentSummary) => void;
    forgetSummaryText: (summary: IAnnotationCommentSummary) => void;
    commentMergePriority: (comment: IAnnotationCommentSummary) => number;
}

interface ICrudSync {
    pendingCommentEditorKeys: Set<string>;
    trackedCreatedEditors: WeakSet<object>;
    syncAnnotationComments: () => Promise<void>;
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
    toEditorSummary: (editor: IPdfjsEditor, pageIndex: number, text?: string, sortIndex?: number | null) => IAnnotationCommentSummary;
    setActiveCommentStableKey: (key: string | null) => void;
    clearSyncState: () => void;
}

interface ICrudFreeTextResize {ensureFreeTextEditorCanResize: (editor: IPdfjsEditor) => void;}

interface ICrudToolManager {updateModeWithRetry: (
    uiManager: AnnotationEditorUIManager,
    mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
    pageNumber?: number,
) => Promise<unknown>;}

interface ICrudInlineIndicators {
    debouncedSyncInlineCommentIndicators: () => void;
    syncInlineCommentIndicators: () => void;
    pulseCommentIndicator: (stableKey: string) => void;
    resolveCommentFromIndicatorElement: (element: HTMLElement) => IAnnotationCommentSummary | null;
    findCommentFromInlineTarget: (target: HTMLElement) => IAnnotationCommentSummary | null;
}

interface ICrudHighlight {
    isPlacingComment: Ref<boolean>;
    placeCommentAtClientPoint: (
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnosticsContext?: {
            attemptId?: string;
            source?: string;
            clickCapturedAtMs?: number;
            clickMeta?: Record<string, unknown>;
        },
    ) => Promise<boolean>;
    findPageContainerFromClientPoint: (clientX: number, clientY: number) => HTMLElement | null;
    buildAnnotationContextMenuPayload: (
        summary: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ) => IAnnotationContextMenuPayload;
}

interface IUseAnnotationCrudOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number 
    }>;
    annotationTool: Ref<TAnnotationTool>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    getIdentity: () => ICrudIdentity;
    getSync: () => ICrudSync;
    getFreeTextResize: () => ICrudFreeTextResize;
    getToolManager: () => ICrudToolManager;
    getInlineIndicators: () => ICrudInlineIndicators;
    getHighlight: () => ICrudHighlight;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (
        range: {
            start: number;
            end: number 
        },
        options?: { preserveRenderedPages?: boolean },
    ) => Promise<void>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolCancel: () => void;
}

export function useAnnotationCrud(options: IUseAnnotationCrudOptions) {
    const {
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
        visibleRange,
        annotationTool,
        annotationCommentsCache,
        getIdentity,
        getSync,
        getFreeTextResize,
        getToolManager,
        getInlineIndicators,
        getHighlight,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationOpenNote,
        emitAnnotationCommentClick,
        emitAnnotationContextMenu,
        emitAnnotationToolCancel,
    } = options;

    const focusPulseTimers: Array<ReturnType<typeof useTimeoutFn>> = [];

    tryOnScopeDispose(() => {
        focusPulseTimers.forEach(t => t.stop());
        focusPulseTimers.length = 0;
    });

    function logCrudDebug(message: string, error: unknown) {
        BrowserLogger.debug('annotations', `${message}: ${errorToLogText(error)}`);
    }

    function nextNotePlacementAttemptId() {
        return `note-${crypto.randomUUID()}`;
    }

    function setActiveCommentAndSync(stableKey: string | null) {
        getSync().setActiveCommentStableKey(stableKey);
        getInlineIndicators().debouncedSyncInlineCommentIndicators();
    }

    function findEditorForComment(comment: IAnnotationCommentSummary) {
        return findEditorForCommentHelper(
            annotationUiManager.value,
            numPages.value,
            comment,
            getIdentity().getEditorIdentity,
        );
    }

    function findEditorByAnnotationElementId(pageIndex: number, annotationId: string) {
        return findEditorByAnnotationElementIdHelper(
            annotationUiManager.value,
            numPages.value,
            pageIndex,
            annotationId,
        );
    }

    function findEditorByMarkerRect(
        comment: IAnnotationCommentSummary,
        preferredPageIndex: number,
    ) {
        const uiManager = annotationUiManager.value;
        if (!uiManager || numPages.value <= 0) {
            return null;
        }

        const pages = [
            Math.max(0, Math.min(preferredPageIndex, numPages.value - 1)),
            ...Array.from({ length: numPages.value }, (_, i) => i).filter(i => i !== preferredPageIndex),
        ];

        let best: {
            editor: IPdfjsEditor;
            pageIndex: number;
            distance: number;
            textScore: number;
        } | null = null;
        const exactTextMatches: Array<{
            editor: IPdfjsEditor;
            pageIndex: number;
            distance: number;
        }> = [];
        const targetText = comment.text.trim();

        for (const pageIndex of pages) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const normalizedEditor = editor as IPdfjsEditor;
                const distance = markerRectCenterDistance(
                    comment.markerRect,
                    toMarkerRectFromEditor(normalizedEditor),
                );
                const editorText = getCommentText(normalizedEditor).trim();
                const textScore = (
                    targetText.length > 0
                    && editorText.length > 0
                    && targetText === editorText
                ) ? 1 : 0;

                if (textScore === 1) {
                    exactTextMatches.push({
                        editor: normalizedEditor,
                        pageIndex,
                        distance, 
                    });
                }

                if (
                    !best
                    || distance < best.distance
                    || (Math.abs(distance - best.distance) <= 0.01 && textScore > best.textScore)
                ) {
                    best = {
                        editor: normalizedEditor,
                        pageIndex,
                        distance,
                        textScore, 
                    };
                }
            }
        }

        const pickBestExactTextMatch = () => {
            if (exactTextMatches.length === 0) {
                return null;
            }
            const ordered = [...exactTextMatches].sort((l, r) => {
                const ld = Number.isFinite(l.distance) ? l.distance : Number.POSITIVE_INFINITY;
                const rd = Number.isFinite(r.distance) ? r.distance : Number.POSITIVE_INFINITY;
                if (ld !== rd) {
                    return ld - rd;
                }
                return l.pageIndex - r.pageIndex;
            });
            const bestMatch = ordered[0] ?? null;
            if (!bestMatch) {
                return null;
            }
            if (ordered.length === 1) {
                return bestMatch;
            }
            const secondBest = ordered[1];
            if (!secondBest) {
                return bestMatch;
            }
            const bd = Number.isFinite(bestMatch.distance) ? bestMatch.distance : Number.POSITIVE_INFINITY;
            const sd = Number.isFinite(secondBest.distance) ? secondBest.distance : Number.POSITIVE_INFINITY;
            if (!Number.isFinite(bd) && !Number.isFinite(sd)) {
                return null;
            }
            if (Math.abs(bd - sd) <= 0.005) {
                return null;
            }
            return bestMatch;
        };

        if (!best) {
            const exactMatch = pickBestExactTextMatch();
            return exactMatch?.editor ?? null;
        }

        const bestDistance = Number.isFinite(best.distance) ? best.distance : Number.POSITIVE_INFINITY;
        if (bestDistance > 0.16 && best.textScore === 0) {
            const exactMatch = pickBestExactTextMatch();
            if (exactMatch) {
                return exactMatch.editor;
            }
            if (bestDistance > 0.42) {
                return null;
            }
        }
        return best.editor;
    }

    function resolveCommentForDelete(comment: IAnnotationCommentSummary) {
        const identity = getIdentity();

        const strictResolved = identity.resolveCommentFromCache(comment);
        if (strictResolved) {
            const hasStablePdfRef = Boolean(strictResolved.annotationId);
            const strictEditor = findEditorForComment(strictResolved);
            if (hasStablePdfRef || strictEditor) {
                return strictResolved;
            }
        }

        const candidates = annotationCommentsCache.value.filter(
            c => c.pageIndex === comment.pageIndex,
        );
        if (candidates.length === 0) {
            return null;
        }

        const targetText = comment.text.trim().toLowerCase();
        const directStableRefMatch = targetText
            ? candidates
                .filter((c) => {
                    const ct = c.text.trim().toLowerCase();
                    return ct.length > 0 && ct === targetText && Boolean(c.annotationId || c.uid);
                })
                .sort((l, r) => {
                    const li = markerRectIoU(comment.markerRect, l.markerRect);
                    const ri = markerRectIoU(comment.markerRect, r.markerRect);
                    if (li !== ri) {
                        return ri - li;
                    }
                    const ld = markerRectCenterDistance(comment.markerRect, l.markerRect);
                    const rd = markerRectCenterDistance(comment.markerRect, r.markerRect);
                    if (ld !== rd) {
                        return ld - rd;
                    }
                    return identity.commentMergePriority(r) - identity.commentMergePriority(l);
                })[0] ?? null
            : null;
        if (directStableRefMatch) {
            return directStableRefMatch;
        }

        const targetSubtype = (comment.subtype ?? '').trim().toLowerCase();
        const scored = candidates.map((candidate) => {
            const ct = candidate.text.trim().toLowerCase();
            const cs = (candidate.subtype ?? '').trim().toLowerCase();
            const textExact = targetText.length > 0 && ct.length > 0 && targetText === ct;
            let score = 0;
            if (textExact) {
                score += 6;
            }
            else if (targetText.length > 0 && ct.length > 0 && (ct.includes(targetText) || targetText.includes(ct))) {
                score += 2;
            }
            else if (targetText.length > 0 && ct.length > 0) {
                score -= 1;
            }
            else if (targetText.length === 0 && ct.length === 0) {
                score += 0.5;
            }

            if (targetSubtype && cs && targetSubtype === cs) score += 1.5;
            if (comment.hasNote === candidate.hasNote) score += 0.5;
            if (candidate.source === comment.source) score += 0.5;
            if (!comment.annotationId && candidate.annotationId) score += 2.1;
            if (!comment.uid && candidate.uid) score += 1.4;
            if (comment.source === 'editor' && candidate.source === 'pdf' && Boolean(candidate.annotationId || candidate.uid)) {
                score += 0.75;
            }
            if (textExact && Boolean(candidate.annotationId || candidate.uid)) score += 0.9;

            const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
            if (iou > 0) {
                score += iou * 6;
            }
            else if (normalizeMarkerRect(comment.markerRect) && normalizeMarkerRect(candidate.markerRect) && !textExact) {
                score -= 0.5;
            }

            return {
                candidate,
                score,
                textExact,
                iou, 
            };
        }).sort((l, r) => r.score - l.score);

        const best = scored[0];
        if (!best) {
            return null;
        }
        const second = scored[1];
        const isClearlyBetter = !second
            || (best.score - second.score >= 0.6)
            || (best.textExact && !second.textExact)
            || ((best.iou - (second.iou ?? 0)) >= 0.08);
        const acceptable = best.score >= 2.5 || best.textExact || best.iou >= 0.12;
        if (!acceptable || !isClearlyBetter) {
            return null;
        }
        return best.candidate;
    }

    function resolveStablePdfDeleteFallback(comment: IAnnotationCommentSummary) {
        const identity = getIdentity();
        const targetText = comment.text.trim().toLowerCase();

        const candidates = annotationCommentsCache.value
            .filter(c => c.pageIndex === comment.pageIndex && Boolean(c.annotationId))
            .map((candidate) => {
                const ct = candidate.text.trim().toLowerCase();
                if (targetText.length > 0 && ct.length > 0 && targetText !== ct) {
                    return null;
                }
                const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
                const distance = markerRectCenterDistance(comment.markerRect, candidate.markerRect);
                return {
                    candidate,
                    iou,
                    distance,
                    score: (
                        (ct && targetText && ct === targetText ? 8 : 0)
                        + (iou * 10)
                        + Math.max(0, 3 - (distance * 8))
                        + identity.commentMergePriority(candidate)
                    ),
                };
            })
            .filter((e): e is NonNullable<typeof e> => Boolean(e))
            .sort((l, r) => {
                if (l.score !== r.score) {
                    return r.score - l.score;
                }
                if (l.iou !== r.iou) {
                    return r.iou - l.iou;
                }
                if (l.distance !== r.distance) {
                    return l.distance - r.distance;
                }
                return r.candidate.stableKey.localeCompare(l.candidate.stableKey);
            });

        const best = candidates[0] ?? null;
        if (!best) {
            return null;
        }
        const second = candidates[1] ?? null;
        const clearlyBetter = !second || (best.score - second.score >= 0.9) || ((best.iou - second.iou) >= 0.1);
        const acceptable = best.iou >= 0.01 || best.distance <= 0.42
            || (targetText.length > 0 && best.candidate.text.trim().toLowerCase() === targetText);
        if (!clearlyBetter || !acceptable) {
            return null;
        }
        return best.candidate;
    }

    async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
        if (!pdfDocument.value) {
            return;
        }
        setActiveCommentAndSync(comment.stableKey);

        const pageNumber = Math.max(1, Math.min(comment.pageNumber, numPages.value));
        scrollToPage(pageNumber);

        await nextTick();
        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(visibleRange.value, { preserveRenderedPages: true });
        }
        catch (error) {
            BrowserLogger.warn('annotations', `Failed to render page ${pageNumber} while focusing annotation comment`, error);
        }

        const inlineIndicators = getInlineIndicators();
        inlineIndicators.syncInlineCommentIndicators();
        await nextTick();
        inlineIndicators.pulseCommentIndicator(comment.stableKey);

        const uiManager = annotationUiManager.value;
        const pageIndex = pageNumber - 1;

        if (uiManager) {
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            }
            catch (waitError) {
                logCrudDebug('Timed out waiting for editors during comment focus', waitError);
            }

            const candidateIds = getCommentCandidateIds(comment);
            for (const id of candidateIds) {
                const editor = getEditorByUidFromLayer(uiManager, pageIndex, id);
                if (editor) {
                    editor.toggleComment?.(true, true);
                    return;
                }
            }
            for (const id of candidateIds) {
                selectCommentByUid(uiManager, pageIndex, id);
            }
        }

        const annotationId = comment.annotationId;
        const container = viewerContainer.value;
        if (!annotationId || !container) {
            return;
        }

        const selector = `[data-annotation-id="${escapeCssAttr(annotationId)}"]`;
        const target = container.querySelector<HTMLElement>(selector);
        if (!target) {
            return;
        }

        target.classList.add('annotation-focus-pulse');
        const timer = useTimeoutFn(() => {
            target.classList.remove('annotation-focus-pulse');
            const index = focusPulseTimers.indexOf(timer);
            if (index !== -1) {
                focusPulseTimers.splice(index, 1);
            }
        }, FOCUS_PULSE_MS);
        focusPulseTimers.push(timer);
    }

    function updateAnnotationComment(comment: IAnnotationCommentSummary, text: string) {
        const identity = getIdentity();
        const commentSync = getSync();
        const inlineIndicators = getInlineIndicators();

        const resolvedComment = resolveCommentForDelete(comment) ?? comment;
        const editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        if (!editor) {
            return false;
        }

        const nextTrimmed = text.trim();
        const previousText = getCommentText(editor);
        const previousTrimmed = previousText.trim();
        const editorPageIndex = Number.isFinite(editor.parentPageIndex)
            ? (editor.parentPageIndex as number)
            : resolvedComment.pageIndex;
        const pendingKey = identity.getEditorPendingKey(editor, editorPageIndex);
        const hadExplicitNote = Boolean(
            resolvedComment.hasNote
            || commentSync.pendingCommentEditorKeys.has(pendingKey)
            || hasEditorCommentPayload(editor)
            || previousTrimmed.length > 0,
        );
        if (text === previousText) {
            return true;
        }

        editor.comment = nextTrimmed.length > 0 ? text : '';
        editor.addToAnnotationStorage?.();

        if (nextTrimmed.length > 0) {
            commentSync.pendingCommentEditorKeys.add(pendingKey);
            identity.rememberSummaryText({
                ...resolvedComment,
                text,
                hasNote: true,
                modifiedAt: Date.now(),
            });
        }
        else {
            if (hadExplicitNote) {
                commentSync.pendingCommentEditorKeys.add(pendingKey);
            }
            else {
                commentSync.pendingCommentEditorKeys.delete(pendingKey);
            }
            if (previousTrimmed.length > 0) {
                identity.forgetSummaryText(resolvedComment);
            }
        }

        emitAnnotationModified();
        commentSync.scheduleAnnotationCommentsSync(true);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
        return true;
    }

    async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        const identity = getIdentity();
        const commentSync = getSync();
        const inlineIndicators = getInlineIndicators();
        const toolManager = getToolManager();

        let resolvedComment = resolveCommentForDelete(comment) ?? comment;
        let pageNumber = Math.max(1, Math.min(resolvedComment.pageNumber, numPages.value));
        let pageIndex = Math.max(0, pageNumber - 1);
        let candidateIds = getCommentCandidateIds(resolvedComment);

        const shouldAttemptPopupMode = () => (
            resolvedComment.source === 'pdf' || Boolean(resolvedComment.annotationId)
        );
        const refreshDeleteTargetFromSync = async () => {
            await commentSync.syncAnnotationComments();
            const syncedMatch = resolveCommentForDelete(resolvedComment) ?? resolveCommentForDelete(comment);
            if (!syncedMatch) {
                return;
            }
            resolvedComment = syncedMatch;
            pageNumber = Math.max(1, Math.min(resolvedComment.pageNumber, numPages.value));
            pageIndex = Math.max(0, pageNumber - 1);
            candidateIds = getCommentCandidateIds(resolvedComment);
        };

        let editor = findEditorForComment(resolvedComment);
        let switchedToPopupMode = false;
        const previousMode = uiManager.getMode();

        if (!editor) {
            await refreshDeleteTargetFromSync();
            editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && shouldAttemptPopupMode() && previousMode !== AnnotationEditorType.POPUP) {
            const switchError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.POPUP, pageNumber);
            if (!switchError) switchedToPopupMode = true;
        }

        if (!editor) {
            try { await uiManager.waitForEditorsRendered(pageNumber); }
            catch (waitError) { logCrudDebug('Timed out waiting for editors before comment delete', waitError); }
            editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && candidateIds.length > 0) {
            for (const id of candidateIds) {
                const byGlobalId = getEditorById(uiManager, id);
                if (byGlobalId) { editor = byGlobalId; break; }
            }
        }

        if (!editor && candidateIds.length > 0) {
            for (const id of candidateIds) {
                const fromLayer = getEditorByUidFromLayer(uiManager, pageIndex, id);
                if (fromLayer) { editor = fromLayer; break; }
            }
        }

        let attemptedCommentSelection = false;
        if (!editor && candidateIds.length > 0) {
            for (const id of candidateIds) {
                attemptedCommentSelection = selectCommentByUid(uiManager, pageIndex, id) || attemptedCommentSelection;
            }
            await nextTick();
            editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && shouldAttemptPopupMode() && resolvedComment.annotationId) {
            const annotationStorage = pdfDocument.value?.annotationStorage as
                | { getEditor?: (annotationElementId: string) => IPdfjsEditor | null }
                | undefined;
            editor = annotationStorage?.getEditor?.(resolvedComment.annotationId) ?? null;
        }

        if (!editor && shouldAttemptPopupMode() && resolvedComment.annotationId) {
            editor = findEditorByAnnotationElementId(pageIndex, resolvedComment.annotationId);
        }

        if (!editor) {
            editor = findEditorByMarkerRect(resolvedComment, pageIndex);
        }

        if (!editor) {
            const stablePdfFallback = resolveStablePdfDeleteFallback(resolvedComment);
            if (stablePdfFallback) {
                resolvedComment = stablePdfFallback;
                pageNumber = Math.max(1, Math.min(resolvedComment.pageNumber, numPages.value));
                pageIndex = Math.max(0, pageNumber - 1);
                candidateIds = getCommentCandidateIds(resolvedComment);
                editor = findEditorForComment(resolvedComment)
                    ?? (resolvedComment.annotationId
                        ? findEditorByAnnotationElementId(pageIndex, resolvedComment.annotationId)
                        : null)
                    ?? findEditorByMarkerRect(resolvedComment, pageIndex);
            }
        }

        let deletedViaSelectionFallback = false;
        if (!editor && attemptedCommentSelection) {
            try { uiManager.delete(); deletedViaSelectionFallback = true; }
            catch (selectionDeleteError) { logCrudDebug('uiManager.delete failed for selected comment fallback', selectionDeleteError); }
        }

        if (!editor && !deletedViaSelectionFallback) {
            BrowserLogger.warn('annotations', 'deleteAnnotationComment: unable to resolve editor for comment', {
                stableKey: resolvedComment.stableKey,
                source: resolvedComment.source,
                annotationId: resolvedComment.annotationId ?? null,
                uid: resolvedComment.uid ?? null,
                id: resolvedComment.id,
                pageNumber,
                candidateIds,
            });
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
            return false;
        }

        const pendingKey = editor
            ? identity.getEditorPendingKey(
                editor,
                Number.isFinite(editor.parentPageIndex)
                    ? (editor.parentPageIndex as number)
                    : resolvedComment.pageIndex,
            )
            : null;
        let deleted = deletedViaSelectionFallback;

        try {
            if (!deleted && editor) {
                setSelectedEditor(uiManager, editor);
                uiManager.delete();
                deleted = true;
            }
        }
        catch (deleteError) {
            logCrudDebug('uiManager.delete failed for annotation comment', deleteError);
            try { editor?.remove?.(); deleted = true; }
            catch (removeError) {
                logCrudDebug('editor.remove failed for annotation comment', removeError);
                try { editor?.delete?.(); deleted = true; }
                catch (legacyDeleteError) {
                    logCrudDebug('editor.delete fallback failed for annotation comment', legacyDeleteError);
                    deleted = false;
                }
            }
        }
        finally {
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
        }

        if (!deleted) {
            return false;
        }

        if (pendingKey) {
            commentSync.pendingCommentEditorKeys.delete(pendingKey);
        }
        else if (candidateIds.length > 0) {
            for (const key of Array.from(commentSync.pendingCommentEditorKeys)) {
                if (candidateIds.some(c => key.endsWith(`:${c}`))) {
                    commentSync.pendingCommentEditorKeys.delete(key);
                }
            }
        }
        identity.forgetSummaryText(resolvedComment);
        identity.forgetSummaryText(comment);
        emitAnnotationModified();
        commentSync.scheduleAnnotationCommentsSync(true);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
        return true;
    }

    function findEditorFromTarget(target: HTMLElement): IEditorTargetMatch | null {
        return findEditorFromTargetHelper(annotationUiManager.value, target, currentPage.value);
    }

    function findEditorSummaryFromTarget(target: HTMLElement) {
        const match = findEditorFromTarget(target);
        if (!match) {
            return null;
        }

        const identity = getIdentity();
        const commentSync = getSync();

        const summary = commentSync.toEditorSummary(match.editor, match.pageIndex, getCommentText(match.editor));
        const normalizedSummary = {
            ...identity.hydrateSummaryFromMemory(summary),
            annotationId: summary.annotationId ?? match.targetAnnotationId,
            stableKey: identity.computeSummaryStableKey({
                id: summary.id,
                pageIndex: summary.pageIndex,
                source: summary.source,
                uid: summary.uid ?? undefined,
                annotationId: summary.annotationId ?? match.targetAnnotationId,
            }),
        };
        const candidateIds = [
            normalizedSummary.annotationId,
            normalizedSummary.uid,
            normalizedSummary.id,
        ]
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const uniqueCandidateIds = uniq(candidateIds);

        const cached = annotationCommentsCache.value.find(
            c => c.pageIndex === match.pageIndex
                && (
                    uniqueCandidateIds.includes(c.annotationId ?? '')
                    || uniqueCandidateIds.includes(c.uid ?? '')
                    || uniqueCandidateIds.includes(c.id)
                ),
        )
            ?? annotationCommentsCache.value.find(
                c => (
                    uniqueCandidateIds.includes(c.annotationId ?? '')
                    || uniqueCandidateIds.includes(c.uid ?? '')
                    || uniqueCandidateIds.includes(c.id)
                ),
            )
            ?? null;

        return cached ?? identity.hydrateSummaryFromMemory(normalizedSummary);
    }

    function findAnnotationSummaryFromTarget(target: HTMLElement) {
        const editorSummary = findEditorSummaryFromTarget(target);
        const pdfSummary = findPdfAnnotationSummaryFromTarget(
            target,
            currentPage.value,
            annotationCommentsCache.value,
        );

        if (!editorSummary) {
            return pdfSummary;
        }
        if (!pdfSummary) {
            return editorSummary;
        }

        const editorText = editorSummary.text.trim();
        const pdfText = pdfSummary.text.trim();
        if (!editorText && pdfText) {
            return pdfSummary;
        }
        if (!editorSummary.modifiedAt && pdfSummary.modifiedAt) {
            return pdfSummary;
        }
        return editorSummary;
    }

    function findAnnotationSummaryFromPoint(target: HTMLElement, clientX: number, clientY: number) {
        return findAnnotationSummaryFromPointHelper(
            target,
            clientX,
            clientY,
            currentPage.value,
            annotationCommentsCache.value,
            getHighlight().findPageContainerFromClientPoint,
        );
    }

    async function ensureEditorInteractionModeFromTarget(target: HTMLElement) {
        const activeTool = annotationTool.value;
        if (activeTool !== 'none' && activeTool !== 'text') {
            return false;
        }

        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        const match = findEditorFromTarget(target);
        if (!match) {
            return false;
        }

        const layerClass = match.editor.div?.closest<HTMLElement>(
            '.annotationEditorLayer, .annotation-editor-layer',
        )?.className ?? '';
        if (!layerClass.includes('nonEditing')) {
            return false;
        }

        const mode = activeTool === 'text' ? AnnotationEditorType.FREETEXT : AnnotationEditorType.POPUP;
        const modeError = await getToolManager().updateModeWithRetry(uiManager, mode, match.pageIndex + 1);
        if (modeError) {
            BrowserLogger.warn('annotations', `Failed to enable editor interaction mode: ${errorToLogText(modeError)}`);
            return false;
        }

        setSelectedEditor(uiManager, match.editor);
        getFreeTextResize().ensureFreeTextEditorCanResize(match.editor);
        return true;
    }

    function clearStickyHighlightSelectionState(editor: IPdfjsEditor | null = null) {
        unselectAllEditors(annotationUiManager.value);

        const clearSelectionVisuals = () => {
            const root = viewerContainer.value ?? document;
            root.querySelectorAll<HTMLElement>(
                '.annotationEditorLayer .highlightEditor.selectedEditor, .annotation-editor-layer .highlightEditor.selectedEditor, .annotationEditorLayer .highlightEditor.selected, .annotation-editor-layer .highlightEditor.selected',
            ).forEach(el => el.classList.remove('selectedEditor', 'selected'));
            root.querySelectorAll<HTMLElement>(
                '.textLayer .highlight.selected, .text-layer .highlight.selected, .highlightOutline.selected',
            ).forEach(el => el.classList.remove('selected'));
            editor?.div?.classList.remove('selectedEditor', 'selected');
            document.getSelection()?.removeAllRanges();
        };

        clearSelectionVisuals();
        if (typeof window !== 'undefined') {
            window.requestAnimationFrame(clearSelectionVisuals);
            window.setTimeout(clearSelectionVisuals, 0);
            window.setTimeout(clearSelectionVisuals, 60);
        }
    }

    function resolveCommentFromIndicatorClickTarget(
        target: HTMLElement,
        clientX: number,
        clientY: number,
    ) {
        const inlineIndicators = getInlineIndicators();

        const customIndicator = target.closest<HTMLElement>(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker',
        );
        if (customIndicator) {
            const inlineTarget = customIndicator.closest<HTMLElement>(
                '.pdf-annotation-has-note-target, .pdf-annotation-has-comment',
            );
            return (
                inlineIndicators.resolveCommentFromIndicatorElement(customIndicator)
                ?? (inlineTarget ? inlineIndicators.findCommentFromInlineTarget(inlineTarget) : null)
                ?? findAnnotationSummaryFromTarget(customIndicator)
                ?? findAnnotationSummaryFromPoint(customIndicator, clientX, clientY)
            );
        }

        const popupTrigger = target.closest<HTMLElement>(
            '.annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        );
        if (popupTrigger) {
            return (
                findAnnotationSummaryFromTarget(popupTrigger)
                ?? findAnnotationSummaryFromPoint(popupTrigger, clientX, clientY)
            );
        }

        return null;
    }

    function handleAnnotationEditorDblClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const explicitCommentTrigger = event.target.closest<HTMLElement>(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        );
        if (!explicitCommentTrigger) {
            return;
        }

        const summary = findAnnotationSummaryFromTarget(explicitCommentTrigger)
            ?? findAnnotationSummaryFromPoint(explicitCommentTrigger, event.clientX, event.clientY);
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            if (isNoteEligibleComment(summary)) {
                emitAnnotationOpenNote(summary);
            }
            else {
                emitAnnotationCommentClick(summary);
            }
            clearStickyHighlightSelectionState(findEditorForComment(summary));
        }
    }

    async function handleAnnotationCommentClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const highlight = getHighlight();
        const inlineIndicators = getInlineIndicators();
        const clickTarget = event.target;

        if (highlight.isPlacingComment.value) {
            const attemptId = nextNotePlacementAttemptId();
            const placementClickMeta = {
                button: event.button,
                buttons: event.buttons,
                detail: event.detail,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            };
            runGuardedTask(
                () => highlight.placeCommentAtClientPoint(event.clientX, event.clientY, clickTarget, {
                    attemptId,
                    source: 'annotation-comment-click',
                    clickCapturedAtMs: Date.now(),
                    clickMeta: placementClickMeta,
                }),
                {
                    scope: 'annotations',
                    message: 'Failed to place annotation comment at pointer location', 
                },
            );
            return;
        }

        const indicatorSummary = resolveCommentFromIndicatorClickTarget(
            event.target,
            event.clientX,
            event.clientY,
        );
        if (indicatorSummary) {
            event.preventDefault();
            event.stopPropagation();
            setActiveCommentAndSync(indicatorSummary.stableKey);
            inlineIndicators.pulseCommentIndicator(indicatorSummary.stableKey);
            if (isNoteEligibleComment(indicatorSummary)) {
                emitAnnotationOpenNote(indicatorSummary);
            }
            else {
                emitAnnotationCommentClick(indicatorSummary);
            }
            clearStickyHighlightSelectionState(findEditorForComment(indicatorSummary));
            return;
        }

        // Bug 2 fix: check inline-target clicks BEFORE the tool guard so that
        // clicking on highlighted text with annotations works even when a tool is active
        const inlineTarget = event.target.closest<HTMLElement>(
            '.pdf-annotation-has-note-target, .pdf-annotation-has-comment',
        );
        if (inlineTarget) {
            event.preventDefault();
            event.stopPropagation();
            const summary = inlineIndicators.findCommentFromInlineTarget(inlineTarget)
                ?? findAnnotationSummaryFromTarget(inlineTarget)
                ?? findAnnotationSummaryFromPoint(inlineTarget, event.clientX, event.clientY);
            if (summary) {
                setActiveCommentAndSync(summary.stableKey);
                inlineIndicators.pulseCommentIndicator(summary.stableKey);
                if (isNoteEligibleComment(summary)) {
                    emitAnnotationOpenNote(summary);
                }
                else {
                    emitAnnotationCommentClick(summary);
                }
                clearStickyHighlightSelectionState(findEditorForComment(summary));
            }
            else {
                clearStickyHighlightSelectionState();
            }
            return;
        }

        if (annotationTool.value !== 'none') {
            if (annotationTool.value === 'text') {
                await ensureEditorInteractionModeFromTarget(event.target);
            }
            return;
        }

        if (event.target.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
            return;
        }

        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
            return;
        }

        await ensureEditorInteractionModeFromTarget(event.target);

        const summary = findAnnotationSummaryFromTarget(event.target)
            ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);
        if (!summary) {
            return;
        }

        setActiveCommentAndSync(summary.stableKey);
        inlineIndicators.pulseCommentIndicator(summary.stableKey);
        emitAnnotationCommentClick(summary);
        clearStickyHighlightSelectionState(findEditorForComment(summary));
    }

    function handleAnnotationCommentContextMenu(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const highlight = getHighlight();
        const inlineIndicators = getInlineIndicators();

        if (highlight.isPlacingComment.value) {
            event.preventDefault();
            return;
        }

        if (annotationTool.value !== 'none') {
            event.preventDefault();
            emitAnnotationToolCancel();
        }

        const inlineTarget = event.target.closest<HTMLElement>(
            '.pdf-annotation-has-note-target, .pdf-annotation-has-comment',
        );
        const summary = (inlineTarget
            ? inlineIndicators.findCommentFromInlineTarget(inlineTarget)
            : null)
            ?? findAnnotationSummaryFromTarget(event.target)
            ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);

        event.preventDefault();
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            inlineIndicators.pulseCommentIndicator(summary.stableKey);
        }
        else {
            setActiveCommentAndSync(null);
        }
        emitAnnotationContextMenu(
            highlight.buildAnnotationContextMenuPayload(summary, event.clientX, event.clientY),
        );
    }

    return {
        findEditorForComment,
        findEditorByAnnotationElementId,
        focusAnnotationComment,
        updateAnnotationComment,
        deleteAnnotationComment,
        findEditorFromTarget,
        findEditorSummaryFromTarget,
        findAnnotationSummaryFromTarget,
        findAnnotationSummaryFromPoint,
        ensureEditorInteractionModeFromTarget,
        resolveCommentFromIndicatorClickTarget,
        handleAnnotationCommentClick,
        handleAnnotationCommentContextMenu,
        handleAnnotationEditorDblClick,
    };
}
