import { AnnotationEditorType } from '@app/services/pdfjs/runtime-lib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    isSelectionMarkupTool,
    isNoteEligibleComment,
    markerRectCenterDistance,
} from '@app/composables/pdf/annotations/annotationRules';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    getCommentText,
    hasEditorCommentPayload,
    toMarkerRectFromEditor,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import {
    normalizeMarkerRect,
    markerRectIoU,
} from '@app/composables/pdf/annotationGeometry';
import {
    escapeCssAttr,
    errorToLogText,
} from '@app/composables/pdf/annotationCssUtils';
import { removeAnnotationCommentDom } from '@app/composables/pdf/annotations/annotationDomRemoval';
import {
    findEditorForComment as findEditorForCommentHelper,
    findEditorByAnnotationElementId as findEditorByAnnotationElementIdHelper,
    findEditorFromTarget as findEditorFromTargetHelper,
    findPdfAnnotationSummaryFromTarget,
    findAnnotationSummaryFromPoint as findAnnotationSummaryFromPointHelper,
} from '@app/composables/pdf/annotationCommentCrudHelpers';
import type { IEditorTargetMatch } from '@app/composables/pdf/annotationCommentCrudHelpers';
import { getCommentCandidateIds } from '@app/composables/pdf/annotationCommentIdentity';
import { runGuardedTask } from '@app/utils/async-guard';
import {
    getEditorById,
    getEditorsOnPage,
    getEditorByUidFromLayer,
    selectCommentByUid,
    setSelectedEditor,
    unselectAllEditors,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';

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

interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}

type TExactMarkerTextMatch = Omit<IMarkerRectEditorMatch, 'textScore'>;

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

export const useAnnotationCrud = (options: IUseAnnotationCrudOptions) => {
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

    const focusPulseTimers = new Set<ReturnType<typeof setTimeout>>();

    tryOnScopeDispose(() => {
        focusPulseTimers.forEach(timer => clearTimeout(timer));
        focusPulseTimers.clear();
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

    function pageSearchOrder(preferredPageIndex: number) {
        return [
            Math.max(0, Math.min(preferredPageIndex, numPages.value - 1)),
            ...Array.from({ length: numPages.value }, (_, i) => i).filter(i => i !== preferredPageIndex),
        ];
    }

    function scoreMarkerRectEditor(
        comment: IAnnotationCommentSummary,
        editor: IPdfjsEditor,
        pageIndex: number,
        targetText: string,
    ): IMarkerRectEditorMatch {
        const distance = markerRectCenterDistance(
            comment.markerRect,
            toMarkerRectFromEditor(editor),
        );
        const editorText = getCommentText(editor).trim();
        const textScore = (
            targetText.length > 0
            && editorText.length > 0
            && targetText === editorText
        ) ? 1 : 0;
        return {
            editor,
            pageIndex,
            distance,
            textScore,
        };
    }

    function isBetterMarkerRectMatch(
        candidate: IMarkerRectEditorMatch,
        best: IMarkerRectEditorMatch | null,
    ) {
        return (
            !best
            || candidate.distance < best.distance
            || (Math.abs(candidate.distance - best.distance) <= 0.01 && candidate.textScore > best.textScore)
        );
    }

    function finiteMarkerDistance(distance: number) {
        return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
    }

    function pickBestExactTextMarkerMatch(exactTextMatches: TExactMarkerTextMatch[]) {
        if (exactTextMatches.length === 0) {
            return null;
        }
        const ordered = [...exactTextMatches].sort((l, r) => {
            const ld = finiteMarkerDistance(l.distance);
            const rd = finiteMarkerDistance(r.distance);
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
        const bd = finiteMarkerDistance(bestMatch.distance);
        const sd = finiteMarkerDistance(secondBest.distance);
        if (!Number.isFinite(bd) && !Number.isFinite(sd)) {
            return null;
        }
        if (Math.abs(bd - sd) <= 0.005) {
            return null;
        }
        return bestMatch;
    }

    function chooseMarkerRectEditorMatch(
        best: IMarkerRectEditorMatch | null,
        exactTextMatches: TExactMarkerTextMatch[],
    ) {
        const exactMatch = pickBestExactTextMarkerMatch(exactTextMatches);
        if (!best) {
            return exactMatch?.editor ?? null;
        }

        const bestDistance = finiteMarkerDistance(best.distance);
        if (bestDistance > 0.16 && best.textScore === 0) {
            if (exactMatch) {
                return exactMatch.editor;
            }
            if (bestDistance > 0.42) {
                return null;
            }
        }
        return best.editor;
    }

    function findEditorByMarkerRect(
        comment: IAnnotationCommentSummary,
        preferredPageIndex: number,
    ) {
        const uiManager = annotationUiManager.value;
        if (!uiManager || numPages.value <= 0) {
            return null;
        }

        let best: IMarkerRectEditorMatch | null = null;
        const exactTextMatches: TExactMarkerTextMatch[] = [];
        const targetText = comment.text.trim();

        for (const pageIndex of pageSearchOrder(preferredPageIndex)) {
            for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
                const candidate = scoreMarkerRectEditor(comment, normalizedEditor, pageIndex, targetText);

                if (candidate.textScore === 1) {
                    exactTextMatches.push({
                        editor: normalizedEditor,
                        pageIndex,
                        distance: candidate.distance,
                    });
                }

                if (isBetterMarkerRectMatch(candidate, best)) {
                    best = candidate;
                }
            }
        }

        return chooseMarkerRectEditorMatch(best, exactTextMatches);
    }

    function findStrictDeleteTarget(comment: IAnnotationCommentSummary) {
        const strictResolved = getIdentity().resolveCommentFromCache(comment);
        if (!strictResolved) {
            return null;
        }

        const hasStablePdfRef = Boolean(strictResolved.annotationId);
        const strictEditor = findEditorForComment(strictResolved);
        return hasStablePdfRef || strictEditor ? strictResolved : null;
    }

    function findDirectStableRefDeleteTarget(
        comment: IAnnotationCommentSummary,
        candidates: IAnnotationCommentSummary[],
        targetText: string,
        identity: ICrudIdentity,
    ) {
        if (!targetText) {
            return null;
        }

        return candidates
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
            })[0] ?? null;
    }

    function scoreDeleteCandidateText(targetText: string, candidateText: string) {
        const textExact = targetText.length > 0 && candidateText.length > 0 && targetText === candidateText;
        let score = 0;

        if (textExact) {
            score += 6;
        }
        else if (
            targetText.length > 0
            && candidateText.length > 0
            && (candidateText.includes(targetText) || targetText.includes(candidateText))
        ) {
            score += 2;
        }
        else if (targetText.length > 0 && candidateText.length > 0) {
            score -= 1;
        }
        else if (targetText.length === 0 && candidateText.length === 0) {
            score += 0.5;
        }

        return {
            score,
            textExact,
        };
    }

    function scoreDeleteCandidateSubtype(
        targetSubtype: string,
        candidateSubtype: string,
    ) {
        return targetSubtype && candidateSubtype && targetSubtype === candidateSubtype ? 1.5 : 0;
    }

    function scoreDeleteCandidateSource(
        comment: IAnnotationCommentSummary,
        candidate: IAnnotationCommentSummary,
    ) {
        let score = 0;
        if (comment.hasNote === candidate.hasNote) score += 0.5;
        if (candidate.source === comment.source) score += 0.5;
        if (comment.source === 'editor' && candidate.source === 'pdf' && Boolean(candidate.annotationId || candidate.uid)) {
            score += 0.75;
        }
        return score;
    }

    function scoreDeleteCandidateRef(
        comment: IAnnotationCommentSummary,
        candidate: IAnnotationCommentSummary,
        textExact: boolean,
    ) {
        let score = 0;
        if (!comment.annotationId && candidate.annotationId) score += 2.1;
        if (!comment.uid && candidate.uid) score += 1.4;
        if (textExact && Boolean(candidate.annotationId || candidate.uid)) score += 0.9;
        return score;
    }

    function scoreDeleteCandidateGeometry(
        comment: IAnnotationCommentSummary,
        candidate: IAnnotationCommentSummary,
        textExact: boolean,
    ) {
        const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
        let score = 0;
        if (iou > 0) {
            score += iou * 6;
        }
        else if (normalizeMarkerRect(comment.markerRect) && normalizeMarkerRect(candidate.markerRect) && !textExact) {
            score -= 0.5;
        }
        return {
            score,
            iou,
        };
    }

    function scoreDeleteCandidate(
        comment: IAnnotationCommentSummary,
        candidate: IAnnotationCommentSummary,
        targetText: string,
        targetSubtype: string,
    ) {
        const ct = candidate.text.trim().toLowerCase();
        const cs = (candidate.subtype ?? '').trim().toLowerCase();
        const textScore = scoreDeleteCandidateText(targetText, ct);
        const geometryScore = scoreDeleteCandidateGeometry(comment, candidate, textScore.textExact);
        const score = textScore.score
            + scoreDeleteCandidateSubtype(targetSubtype, cs)
            + scoreDeleteCandidateSource(comment, candidate)
            + scoreDeleteCandidateRef(comment, candidate, textScore.textExact)
            + geometryScore.score;

        return {
            candidate,
            score,
            textExact: textScore.textExact,
            iou: geometryScore.iou,
        };
    }

    function pickScoredDeleteTarget(
        scored: Array<ReturnType<typeof scoreDeleteCandidate>>,
    ) {
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
        return acceptable && isClearlyBetter ? best.candidate : null;
    }

    function resolveCommentForDelete(comment: IAnnotationCommentSummary) {
        const identity = getIdentity();
        const strictResolved = findStrictDeleteTarget(comment);
        if (strictResolved) {
            return strictResolved;
        }

        const candidates = annotationCommentsCache.value.filter(
            c => c.pageIndex === comment.pageIndex,
        );
        if (candidates.length === 0) {
            return null;
        }

        const targetText = comment.text.trim().toLowerCase();
        const directStableRefMatch = findDirectStableRefDeleteTarget(comment, candidates, targetText, identity);
        if (directStableRefMatch) {
            return directStableRefMatch;
        }

        const targetSubtype = (comment.subtype ?? '').trim().toLowerCase();
        const scored = candidates
            .map(candidate => scoreDeleteCandidate(comment, candidate, targetText, targetSubtype))
            .sort((l, r) => r.score - l.score);

        return pickScoredDeleteTarget(scored);
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
        const timer = setTimeout(() => {
            target.classList.remove('annotation-focus-pulse');
            focusPulseTimers.delete(timer);
        }, FOCUS_PULSE_MS);
        focusPulseTimers.add(timer);
    }

    function logMissingEditorForCommentUpdate(
        comment: IAnnotationCommentSummary,
        resolvedComment: IAnnotationCommentSummary,
    ) {
        const candidateIds = uniq([
            ...getCommentCandidateIds(comment),
            ...getCommentCandidateIds(resolvedComment),
        ]);
        const uiManager = annotationUiManager.value;
        const editorCountsByPage = uiManager
            ? Array.from({ length: Math.max(0, numPages.value) }, (_, pageIndex) => ({
                pageIndex,
                count: getEditorsOnPage(uiManager, pageIndex).length,
            }))
            : [];
        const nonEmptyPages = editorCountsByPage
            .filter(entry => entry.count > 0)
            .slice(0, 8);
        const totalEditors = editorCountsByPage.reduce((sum, entry) => sum + entry.count, 0);
        BrowserLogger.warn('annotations', 'updateAnnotationComment: unable to resolve editor for note persistence', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            resolvedStableKey: resolvedComment.stableKey,
            resolvedSource: resolvedComment.source,
            resolvedAnnotationId: resolvedComment.annotationId ?? null,
            pageNumber: comment.pageNumber,
            candidateIds,
            totalPages: numPages.value,
            totalEditors,
            nonEmptyPages,
        });
    }

    function emitAnnotationCommentMutation(
        commentSync: ICrudSync,
        inlineIndicators: ICrudInlineIndicators,
    ) {
        emitAnnotationModified();
        commentSync.scheduleAnnotationCommentsSync(true);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
    }

    function updateAnnotationComment(comment: IAnnotationCommentSummary, text: string) {
        const identity = getIdentity();
        const commentSync = getSync();
        const inlineIndicators = getInlineIndicators();

        const resolvedComment = resolveCommentForDelete(comment) ?? comment;
        const preferredPageIndex = Number.isFinite(resolvedComment.pageIndex)
            ? resolvedComment.pageIndex
            : comment.pageIndex;
        const editor = findEditorForComment(resolvedComment)
            ?? findEditorForComment(comment)
            ?? (resolvedComment.annotationId ? findPopupModeDeleteEditor(preferredPageIndex, resolvedComment) : null)
            ?? (comment.annotationId ? findPopupModeDeleteEditor(comment.pageIndex, comment) : null)
            ?? findEditorByMarkerRect(resolvedComment, preferredPageIndex)
            ?? findEditorByMarkerRect(comment, comment.pageIndex);
        if (!editor) {
            logMissingEditorForCommentUpdate(comment, resolvedComment);
            return false;
        }

        const nextTrimmed = text.trim();
        const nextRawLength = text.length;
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

        editor.comment = nextRawLength > 0 ? text : '';
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

        emitAnnotationCommentMutation(commentSync, inlineIndicators);
        return true;
    }

    function toDeleteTargetState(comment: IAnnotationCommentSummary) {
        const pageNumber = Math.max(1, Math.min(comment.pageNumber, numPages.value));
        return {
            comment,
            pageNumber,
            pageIndex: Math.max(0, pageNumber - 1),
            candidateIds: getCommentCandidateIds(comment),
        };
    }

    function shouldAttemptPopupModeForDelete(comment: IAnnotationCommentSummary) {
        return comment.source === 'pdf' || Boolean(comment.annotationId);
    }

    function findEditorByDeleteCandidateIds(
        uiManager: AnnotationEditorUIManager,
        pageIndex: number,
        candidateIds: string[],
    ) {
        for (const id of candidateIds) {
            const byGlobalId = getEditorById(uiManager, id);
            if (byGlobalId) {
                return byGlobalId;
            }
        }

        for (const id of candidateIds) {
            const fromLayer = getEditorByUidFromLayer(uiManager, pageIndex, id);
            if (fromLayer) {
                return fromLayer;
            }
        }

        return null;
    }

    async function selectDeleteCandidates(
        uiManager: AnnotationEditorUIManager,
        pageIndex: number,
        candidateIds: string[],
    ) {
        let attemptedCommentSelection = false;
        for (const id of candidateIds) {
            attemptedCommentSelection = selectCommentByUid(uiManager, pageIndex, id) || attemptedCommentSelection;
        }
        await nextTick();
        return attemptedCommentSelection;
    }

    function findPopupModeDeleteEditor(
        pageIndex: number,
        comment: IAnnotationCommentSummary,
    ) {
        if (!shouldAttemptPopupModeForDelete(comment) || !comment.annotationId) {
            return null;
        }

        const annotationStorage = pdfDocument.value?.annotationStorage as
            | { getEditor?: (annotationElementId: string) => IPdfjsEditor | null }
            | undefined;
        return annotationStorage?.getEditor?.(comment.annotationId)
            ?? findEditorByAnnotationElementId(pageIndex, comment.annotationId);
    }

    async function resolveDeleteEditor(
        uiManager: AnnotationEditorUIManager,
        originalComment: IAnnotationCommentSummary,
        target: ReturnType<typeof toDeleteTargetState>,
    ) {
        let editor = findEditorForComment(target.comment);
        let attemptedCommentSelection = false;

        if (!editor) {
            try { await uiManager.waitForEditorsRendered(target.pageNumber); }
            catch (waitError) { logCrudDebug('Timed out waiting for editors before comment delete', waitError); }
            editor = findEditorForComment(target.comment) ?? findEditorForComment(originalComment);
        }

        if (!editor && target.candidateIds.length > 0) {
            editor = findEditorByDeleteCandidateIds(uiManager, target.pageIndex, target.candidateIds);
        }

        if (!editor && target.candidateIds.length > 0) {
            attemptedCommentSelection = await selectDeleteCandidates(uiManager, target.pageIndex, target.candidateIds);
            editor = findEditorForComment(target.comment) ?? findEditorForComment(originalComment);
        }

        return {
            editor: editor
                ?? findPopupModeDeleteEditor(target.pageIndex, target.comment)
                ?? findEditorByMarkerRect(target.comment, target.pageIndex),
            attemptedCommentSelection,
        };
    }

    function findStablePdfFallbackDeleteEditor(
        target: ReturnType<typeof toDeleteTargetState>,
    ) {
        return findEditorForComment(target.comment)
            ?? (target.comment.annotationId
                ? findEditorByAnnotationElementId(target.pageIndex, target.comment.annotationId)
                : null)
            ?? findEditorByMarkerRect(target.comment, target.pageIndex);
    }

    async function switchToPopupModeForDelete(
        toolManager: ICrudToolManager,
        uiManager: AnnotationEditorUIManager,
        comment: IAnnotationCommentSummary,
        pageNumber: number,
        previousMode: ReturnType<AnnotationEditorUIManager['getMode']>,
    ) {
        if (!shouldAttemptPopupModeForDelete(comment) || previousMode === AnnotationEditorType.POPUP) {
            return false;
        }

        const switchError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.POPUP, pageNumber);
        return !switchError;
    }

    async function restorePopupModeAfterDelete(
        toolManager: ICrudToolManager,
        uiManager: AnnotationEditorUIManager,
        switchedToPopupMode: boolean,
        previousMode: ReturnType<AnnotationEditorUIManager['getMode']>,
        pageNumber: number,
    ) {
        if (switchedToPopupMode) {
            await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        }
    }

    function deleteSelectedAnnotationComment(
        uiManager: AnnotationEditorUIManager,
        editor: IPdfjsEditor | null,
        deletedViaSelectionFallback: boolean,
    ) {
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

        return deleted;
    }

    function removePendingDeleteKeys(commentSync: ICrudSync, pendingKey: string | null, candidateIds: string[]) {
        if (pendingKey) {
            commentSync.pendingCommentEditorKeys.delete(pendingKey);
            return;
        }
        if (candidateIds.length === 0) {
            return;
        }
        for (const key of Array.from(commentSync.pendingCommentEditorKeys)) {
            if (candidateIds.some(c => key.endsWith(`:${c}`))) {
                commentSync.pendingCommentEditorKeys.delete(key);
            }
        }
    }

    function logUnresolvedDeleteTarget(
        resolvedComment: IAnnotationCommentSummary,
        deleteTarget: ReturnType<typeof toDeleteTargetState>,
    ) {
        BrowserLogger.warn('annotations', 'deleteAnnotationComment: unable to resolve editor for comment', {
            stableKey: resolvedComment.stableKey,
            source: resolvedComment.source,
            annotationId: resolvedComment.annotationId ?? null,
            uid: resolvedComment.uid ?? null,
            id: resolvedComment.id,
            pageNumber: deleteTarget.pageNumber,
            candidateIds: deleteTarget.candidateIds,
        });
    }

    function createDeleteTargetState(comment: IAnnotationCommentSummary) {
        let resolvedComment = resolveCommentForDelete(comment) ?? comment;
        let deleteTarget = toDeleteTargetState(resolvedComment);

        return {
            get resolvedComment() {
                return resolvedComment;
            },
            get deleteTarget() {
                return deleteTarget;
            },
            sync(nextComment: IAnnotationCommentSummary) {
                resolvedComment = nextComment;
                deleteTarget = toDeleteTargetState(nextComment);
            },
        };
    }

    async function refreshDeleteTargetFromSync(
        commentSync: ICrudSync,
        state: ReturnType<typeof createDeleteTargetState>,
        originalComment: IAnnotationCommentSummary,
    ) {
        await commentSync.syncAnnotationComments();
        const syncedMatch = resolveCommentForDelete(state.resolvedComment) ?? resolveCommentForDelete(originalComment);
        if (syncedMatch) {
            state.sync(syncedMatch);
        }
    }

    function getDeletePendingKey(
        identity: ICrudIdentity,
        editor: IPdfjsEditor | null,
        deleteTarget: ReturnType<typeof toDeleteTargetState>,
    ) {
        if (!editor) {
            return null;
        }
        return identity.getEditorPendingKey(
            editor,
            Number.isFinite(editor.parentPageIndex)
                ? (editor.parentPageIndex as number)
                : deleteTarget.comment.pageIndex,
        );
    }

    function deleteViaSelectedCommentFallback(
        uiManager: AnnotationEditorUIManager,
        attemptedCommentSelection: boolean,
        hasEditor: boolean,
    ) {
        if (hasEditor || !attemptedCommentSelection) {
            return false;
        }
        try {
            uiManager.delete();
            return true;
        } catch (selectionDeleteError) {
            logCrudDebug('uiManager.delete failed for selected comment fallback', selectionDeleteError);
            return false;
        }
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

        const deleteState = createDeleteTargetState(comment);

        let editor = findEditorForComment(deleteState.resolvedComment);
        let switchedToPopupMode = false;
        const previousMode = uiManager.getMode();

        if (!editor) {
            await refreshDeleteTargetFromSync(commentSync, deleteState, comment);
            editor = findEditorForComment(deleteState.resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && shouldAttemptPopupModeForDelete(deleteState.resolvedComment) && previousMode !== AnnotationEditorType.POPUP) {
            switchedToPopupMode = await switchToPopupModeForDelete(
                toolManager,
                uiManager,
                deleteState.resolvedComment,
                deleteState.deleteTarget.pageNumber,
                previousMode,
            );
        }

        let attemptedCommentSelection = false;
        if (!editor) {
            const resolved = await resolveDeleteEditor(uiManager, comment, deleteState.deleteTarget);
            editor = resolved.editor;
            attemptedCommentSelection = resolved.attemptedCommentSelection;
        }

        if (!editor) {
            const stablePdfFallback = resolveStablePdfDeleteFallback(deleteState.resolvedComment);
            if (stablePdfFallback) {
                deleteState.sync(stablePdfFallback);
                editor = findStablePdfFallbackDeleteEditor(deleteState.deleteTarget);
            }
        }

        const deletedViaSelectionFallback = deleteViaSelectedCommentFallback(uiManager, attemptedCommentSelection, Boolean(editor));

        if (!editor && !deletedViaSelectionFallback) {
            logUnresolvedDeleteTarget(deleteState.resolvedComment, deleteState.deleteTarget);
            await restorePopupModeAfterDelete(toolManager, uiManager, switchedToPopupMode, previousMode, deleteState.deleteTarget.pageNumber);
            return false;
        }

        const pendingKey = getDeletePendingKey(identity, editor, deleteState.deleteTarget);
        const deleted = deleteSelectedAnnotationComment(uiManager, editor, deletedViaSelectionFallback);
        await restorePopupModeAfterDelete(toolManager, uiManager, switchedToPopupMode, previousMode, deleteState.deleteTarget.pageNumber);

        if (!deleted) {
            return false;
        }

        removePendingDeleteKeys(commentSync, pendingKey, deleteState.deleteTarget.candidateIds);
        identity.forgetSummaryText(deleteState.resolvedComment);
        identity.forgetSummaryText(comment);
        emitAnnotationCommentMutation(commentSync, inlineIndicators);
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

        const activeTool = annotationTool.value;
        const mode = activeTool === 'text'
            ? AnnotationEditorType.FREETEXT
            : AnnotationEditorType.POPUP;
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
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .pdf-comment-marker-button',
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

    function emitResolvedCommentClick(
        summary: IAnnotationCommentSummary,
        inlineIndicators: ICrudInlineIndicators,
        options: { openEligibleNote: boolean } = { openEligibleNote: true },
    ) {
        setActiveCommentAndSync(summary.stableKey);
        inlineIndicators.pulseCommentIndicator(summary.stableKey);
        if (options.openEligibleNote && isNoteEligibleComment(summary)) {
            emitAnnotationOpenNote(summary);
        }
        else {
            emitAnnotationCommentClick(summary);
        }
    }

    function getPlacementClickMeta(event: MouseEvent) {
        return {
            button: event.button,
            buttons: event.buttons,
            detail: event.detail,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        };
    }

    function handleCommentPlacementClick(event: MouseEvent, clickTarget: HTMLElement, highlight: ICrudHighlight) {
        const attemptId = nextNotePlacementAttemptId();
        runGuardedTask(
            () => highlight.placeCommentAtClientPoint(event.clientX, event.clientY, clickTarget, {
                attemptId,
                source: 'annotation-comment-click',
                clickCapturedAtMs: Date.now(),
                clickMeta: getPlacementClickMeta(event),
            }),
            {
                scope: 'annotations',
                message: 'Failed to place annotation comment at pointer location',
            },
        );
    }

    async function prepareClickedEditorForCommentInteraction(clickTarget: HTMLElement, clickedEditorMatch: IEditorTargetMatch | null) {
        if (!clickedEditorMatch) {
            return;
        }
        if (isSelectionMarkupTool(annotationTool.value)) {
            return;
        }
        if (annotationTool.value !== 'none') {
            emitAnnotationToolCancel();
            await nextTick();
        }

        await ensureEditorInteractionModeFromTarget(clickTarget);
    }

    function resolveInlineTargetComment(
        inlineTarget: HTMLElement,
        inlineIndicators: ICrudInlineIndicators,
        event: MouseEvent,
    ) {
        return inlineIndicators.findCommentFromInlineTarget(inlineTarget)
            ?? findAnnotationSummaryFromTarget(inlineTarget)
            ?? findAnnotationSummaryFromPoint(inlineTarget, event.clientX, event.clientY);
    }

    function emitResolvedCommentClickAndClearSelection(
        summary: IAnnotationCommentSummary,
        inlineIndicators: ICrudInlineIndicators,
        options?: { openEligibleNote: boolean },
    ) {
        emitResolvedCommentClick(summary, inlineIndicators, options);
        clearStickyHighlightSelectionState(findEditorForComment(summary));
    }

    function consumeResolvedCommentClick(
        event: MouseEvent,
        summary: IAnnotationCommentSummary,
        inlineIndicators: ICrudInlineIndicators,
        options?: { openEligibleNote: boolean },
    ) {
        event.preventDefault();
        event.stopPropagation();
        emitResolvedCommentClickAndClearSelection(summary, inlineIndicators, options);
    }

    function handleAnnotationEditorDblClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const explicitCommentTrigger = event.target.closest<HTMLElement>(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .pdf-comment-marker-button, .annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
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
        const clickedEditorMatch = findEditorFromTarget(clickTarget);

        if (highlight.isPlacingComment.value) {
            handleCommentPlacementClick(event, clickTarget, highlight);
            return;
        }

        await prepareClickedEditorForCommentInteraction(clickTarget, clickedEditorMatch);

        const indicatorSummary = resolveCommentFromIndicatorClickTarget(
            event.target,
            event.clientX,
            event.clientY,
        );
        if (indicatorSummary) {
            consumeResolvedCommentClick(event, indicatorSummary, inlineIndicators);
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
            const summary = resolveInlineTargetComment(inlineTarget, inlineIndicators, event);
            if (summary) {
                emitResolvedCommentClickAndClearSelection(summary, inlineIndicators);
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

        emitResolvedCommentClick(summary, inlineIndicators, { openEligibleNote: false });
        if (!clickedEditorMatch) {
            clearStickyHighlightSelectionState(findEditorForComment(summary));
        }
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

    function removeAnnotationFromDom(comment: IAnnotationCommentSummary) {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }

        removeAnnotationCommentDom(container, comment);
    }

    return {
        findEditorForComment,
        findEditorByAnnotationElementId,
        focusAnnotationComment,
        updateAnnotationComment,
        deleteAnnotationComment,
        removeAnnotationFromDom,
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
};
