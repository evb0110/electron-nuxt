import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    nextTick,
    type Ref,
    type ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    hasEditorCommentPayload,
    normalizeMarkerRect,
    markerRectIoU,
    toMarkerRectFromEditor,
    escapeCssAttr,
    errorToLogText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useInlineCommentIndicators } from '@app/composables/pdf/useInlineCommentIndicators';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { useAnnotationHighlight } from '@app/composables/pdf/useAnnotationHighlight';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';
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

export type { IEditorTargetMatch } from '@app/composables/pdf/annotationCommentCrudHelpers';
export {
    getCommentCandidateIds,
    findPdfAnnotationSummaryFromTarget,
} from '@app/composables/pdf/annotationCommentCrudHelpers';

type TFreeTextResize = ReturnType<typeof useFreeTextResize>;
type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;
type TInlineIndicators = ReturnType<typeof useInlineCommentIndicators>;
type TToolManager = ReturnType<typeof useAnnotationToolManager>;
type THighlight = ReturnType<typeof useAnnotationHighlight>;

type TUiManagerSelectedEditor = Parameters<
    AnnotationEditorUIManager['setSelected']
>[0];

interface IUseAnnotationCommentCrudOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    annotationTool: Ref<TAnnotationTool>;
    identity: TIdentity;
    commentSync: TCommentSync;
    freeTextResize: TFreeTextResize;
    toolManager: TToolManager;
    inlineIndicators: TInlineIndicators;
    highlight: THighlight;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
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

export function useAnnotationCommentCrud(
    options: IUseAnnotationCommentCrudOptions,
) {
    const {
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
        visibleRange,
        annotationTool,
        identity,
        commentSync,
        freeTextResize,
        toolManager,
        inlineIndicators,
        highlight,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationOpenNote,
        emitAnnotationCommentClick,
        emitAnnotationContextMenu,
        emitAnnotationToolCancel,
    } = options;

    function logCrudDebug(message: string, error: unknown) {
        BrowserLogger.debug('annotations', `${message}: ${errorToLogText(error)}`);
    }

    function markerRectCenterDistance(
        left: IAnnotationCommentSummary['markerRect'] | null | undefined,
        right: IAnnotationCommentSummary['markerRect'] | null | undefined,
    ) {
        const a = normalizeMarkerRect(left);
        const b = normalizeMarkerRect(right);
        if (!a || !b) {
            return Number.POSITIVE_INFINITY;
        }
        const ax = a.left + a.width / 2;
        const ay = a.top + a.height / 2;
        const bx = b.left + b.width / 2;
        const by = b.top + b.height / 2;
        return Math.hypot(ax - bx, ay - by);
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
            ...Array.from({ length: numPages.value }, (_, index) => index).filter(index => index !== preferredPageIndex),
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
                )
                    ? 1
                    : 0;
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
            const ordered = [...exactTextMatches].sort((left, right) => {
                const leftDistance = Number.isFinite(left.distance)
                    ? left.distance
                    : Number.POSITIVE_INFINITY;
                const rightDistance = Number.isFinite(right.distance)
                    ? right.distance
                    : Number.POSITIVE_INFINITY;
                if (leftDistance !== rightDistance) {
                    return leftDistance - rightDistance;
                }
                return left.pageIndex - right.pageIndex;
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
            const bestDistance = Number.isFinite(bestMatch.distance)
                ? bestMatch.distance
                : Number.POSITIVE_INFINITY;
            const secondDistance = Number.isFinite(secondBest.distance)
                ? secondBest.distance
                : Number.POSITIVE_INFINITY;
            if (!Number.isFinite(bestDistance) && !Number.isFinite(secondDistance)) {
                return null;
            }
            if (Math.abs(bestDistance - secondDistance) <= 0.005) {
                return null;
            }
            return bestMatch;
        };

        if (!best) {
            const exactMatch = pickBestExactTextMatch();
            if (exactMatch) {
                BrowserLogger.debug('annotations', 'Resolved editor for delete by exact text fallback', {
                    stableKey: comment.stableKey,
                    pageIndex: exactMatch.pageIndex,
                    distance: exactMatch.distance,
                    editorUid: exactMatch.editor.uid ?? null,
                    editorId: exactMatch.editor.id ?? null,
                });
                return exactMatch.editor;
            }
            return null;
        }
        if (best.distance > 0.16 && best.textScore === 0) {
            const exactMatch = pickBestExactTextMatch();
            if (exactMatch) {
                BrowserLogger.debug('annotations', 'Resolved editor for delete by exact text fallback after distance gate', {
                    stableKey: comment.stableKey,
                    pageIndex: exactMatch.pageIndex,
                    distance: exactMatch.distance,
                    editorUid: exactMatch.editor.uid ?? null,
                    editorId: exactMatch.editor.id ?? null,
                });
                return exactMatch.editor;
            }
            return null;
        }
        BrowserLogger.debug('annotations', 'Resolved editor for delete by marker proximity', {
            stableKey: comment.stableKey,
            pageIndex: best.pageIndex,
            distance: best.distance,
            textScore: best.textScore,
            editorUid: best.editor.uid ?? null,
            editorId: best.editor.id ?? null,
        });
        return best.editor;
    }

    function resolveCommentForDelete(comment: IAnnotationCommentSummary) {
        const strictResolved = identity.resolveCommentFromCache(comment);
        if (strictResolved) {
            const hasStablePdfRef = Boolean(strictResolved.annotationId);
            const strictEditor = findEditorForComment(strictResolved);
            if (hasStablePdfRef || strictEditor) {
                return strictResolved;
            }
            BrowserLogger.debug('annotations', 'Strict delete comment match looked stale; continuing with fuzzy remap', {
                requestedStableKey: comment.stableKey,
                strictStableKey: strictResolved.stableKey,
                requestedId: comment.id,
                strictId: strictResolved.id,
                requestedUid: comment.uid ?? null,
                strictUid: strictResolved.uid ?? null,
                pageIndex: comment.pageIndex,
            });
        }

        const candidates = commentSync.annotationCommentsCache.value.filter((candidate) => (
            candidate.pageIndex === comment.pageIndex
        ));
        if (candidates.length === 0) {
            BrowserLogger.debug('annotations', 'No cache candidates available for fuzzy delete remap', {
                requestedStableKey: comment.stableKey,
                requestedId: comment.id,
                requestedUid: comment.uid ?? null,
                requestedSource: comment.source,
                pageIndex: comment.pageIndex,
            });
            return null;
        }

        const targetText = comment.text.trim().toLowerCase();
        const targetSubtype = (comment.subtype ?? '').trim().toLowerCase();

        const scored = candidates.map((candidate) => {
            const candidateText = candidate.text.trim().toLowerCase();
            const candidateSubtype = (candidate.subtype ?? '').trim().toLowerCase();
            const textExact = (
                targetText.length > 0
                && candidateText.length > 0
                && targetText === candidateText
            );
            let score = 0;
            if (textExact) {
                score += 6;
            } else if (
                targetText.length > 0
                && candidateText.length > 0
                && (
                    candidateText.includes(targetText)
                    || targetText.includes(candidateText)
                )
            ) {
                score += 2;
            } else if (targetText.length > 0 && candidateText.length > 0) {
                score -= 1;
            } else if (targetText.length === 0 && candidateText.length === 0) {
                score += 0.5;
            }

            if (targetSubtype && candidateSubtype && targetSubtype === candidateSubtype) {
                score += 1.5;
            }
            if (comment.hasNote === candidate.hasNote) {
                score += 0.5;
            }
            if (candidate.source === comment.source) {
                score += 0.5;
            }

            const iou = markerRectIoU(comment.markerRect, candidate.markerRect);
            if (iou > 0) {
                score += iou * 6;
            } else if (normalizeMarkerRect(comment.markerRect) && normalizeMarkerRect(candidate.markerRect)) {
                score -= 0.5;
            }

            return {
                candidate,
                score,
                textExact,
                iou,
            };
        }).sort((left, right) => right.score - left.score);

        const best = scored[0];
        if (!best) {
            return null;
        }
        const second = scored[1];
        const isClearlyBetter = (
            !second
            || (best.score - second.score >= 0.6)
            || (best.textExact && !second.textExact)
            || ((best.iou - (second.iou ?? 0)) >= 0.08)
        );
        const acceptable = (
            best.score >= 2.5
            || best.textExact
            || best.iou >= 0.12
        );
        if (!acceptable || !isClearlyBetter) {
            BrowserLogger.debug('annotations', 'Fuzzy delete remap rejected due low confidence', {
                requestedStableKey: comment.stableKey,
                requestedId: comment.id,
                requestedUid: comment.uid ?? null,
                pageIndex: comment.pageIndex,
                candidateCount: scored.length,
                best: best
                    ? {
                        stableKey: best.candidate.stableKey,
                        id: best.candidate.id,
                        uid: best.candidate.uid ?? null,
                        source: best.candidate.source,
                        score: best.score,
                        iou: best.iou,
                        textExact: best.textExact,
                    }
                    : null,
                second: second
                    ? {
                        stableKey: second.candidate.stableKey,
                        id: second.candidate.id,
                        uid: second.candidate.uid ?? null,
                        source: second.candidate.source,
                        score: second.score,
                        iou: second.iou,
                        textExact: second.textExact,
                    }
                    : null,
            });
            return null;
        }

        BrowserLogger.debug('annotations', 'Resolved stale delete comment via fuzzy cache match', {
            requestedStableKey: comment.stableKey,
            resolvedStableKey: best.candidate.stableKey,
            requestedId: comment.id,
            resolvedId: best.candidate.id,
            requestedUid: comment.uid ?? null,
            resolvedUid: best.candidate.uid ?? null,
            score: best.score,
            iou: best.iou,
            textExact: best.textExact,
        });

        return best.candidate;
    }

    function setActiveCommentAndSync(stableKey: string | null) {
        commentSync.setActiveCommentStableKey(stableKey);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
    }

    function findEditorForComment(comment: IAnnotationCommentSummary) {
        return findEditorForCommentHelper(
            annotationUiManager.value,
            numPages.value,
            comment,
            identity.getEditorIdentity,
        );
    }

    function findEditorByAnnotationElementId(
        pageIndex: number,
        annotationId: string,
    ) {
        return findEditorByAnnotationElementIdHelper(
            annotationUiManager.value,
            numPages.value,
            pageIndex,
            annotationId,
        );
    }

    async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
        if (!pdfDocument.value) {
            return;
        }
        setActiveCommentAndSync(comment.stableKey);

        const pageNumber = Math.max(
            1,
            Math.min(comment.pageNumber, numPages.value),
        );
        scrollToPage(pageNumber);

        await nextTick();
        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(visibleRange.value, {preserveRenderedPages: true});
        } catch (error) {
            BrowserLogger.warn(
                'annotations',
                `Failed to render page ${pageNumber} while focusing annotation comment`,
                error,
            );
        }
        inlineIndicators.syncInlineCommentIndicators();
        await nextTick();
        inlineIndicators.pulseCommentIndicator(comment.stableKey);

        const uiManager = annotationUiManager.value as
      | (AnnotationEditorUIManager & {
          getLayer?: (
              pageIndex: number,
          ) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
          selectComment?: (pageIndex: number, uid: string) => void;
      })
      | null;
        const pageIndex = pageNumber - 1;

        if (uiManager) {
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch (waitError) {
                logCrudDebug(
                    'Timed out waiting for editors during comment focus',
                    waitError,
                );
            }

            const layer = uiManager.getLayer?.(pageIndex) ?? null;
            const candidateIds = getCommentCandidateIds(comment);

            for (const id of candidateIds) {
                const editor = layer?.getEditorByUID?.(id);
                if (editor) {
                    editor.toggleComment?.(true, true);
                    return;
                }
            }

            if (typeof uiManager.selectComment === 'function') {
                for (const id of candidateIds) {
                    uiManager.selectComment(pageIndex, id);
                }
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
        setTimeout(() => {
            target.classList.remove('annotation-focus-pulse');
        }, FOCUS_PULSE_MS);
    }

    function updateAnnotationComment(
        comment: IAnnotationCommentSummary,
        text: string,
    ) {
        const resolvedComment = resolveCommentForDelete(comment) ?? comment;
        const editor =
            findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        if (!editor) {
            return false;
        }

        const nextText = text;
        const nextTrimmed = nextText.trim();
        const previousText = getCommentText(editor);
        const previousTrimmed = previousText.trim();
        const editorPageIndex = Number.isFinite(editor.parentPageIndex)
            ? (editor.parentPageIndex as number)
            : resolvedComment.pageIndex;
        const pendingKey = identity.getEditorPendingKey(editor, editorPageIndex);
        const hadExplicitNote = Boolean(
            resolvedComment.hasNote ||
      commentSync.pendingCommentEditorKeys.has(pendingKey) ||
      hasEditorCommentPayload(editor) ||
      previousTrimmed.length > 0,
        );
        if (nextText === previousText) {
            return true;
        }

        editor.comment = nextTrimmed.length > 0 ? nextText : '';
        editor.addToAnnotationStorage?.();
        if (nextTrimmed.length > 0) {
            commentSync.pendingCommentEditorKeys.add(pendingKey);
            identity.rememberSummaryText({
                ...resolvedComment,
                text: nextText,
                hasNote: true,
                modifiedAt: Date.now(),
            });
        } else {
            if (hadExplicitNote) {
                commentSync.pendingCommentEditorKeys.add(pendingKey);
            } else {
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
        let resolvedComment = resolveCommentForDelete(comment) ?? comment;

        let pageNumber = Math.max(
            1,
            Math.min(resolvedComment.pageNumber, numPages.value),
        );
        let pageIndex = Math.max(0, pageNumber - 1);
        let candidateIds = getCommentCandidateIds(resolvedComment);
        const managerWithCommentSelection =
            uiManager as AnnotationEditorUIManager & {
                selectComment?: (candidatePageIndex: number, uid: string) => void;
                getEditor?: (id: string) => IPdfjsEditor | null;
                getLayer?: (
                    candidatePageIndex: number,
                ) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
            };
        BrowserLogger.debug('annotations', 'deleteAnnotationComment: start', {
            stableKey: resolvedComment.stableKey,
            source: resolvedComment.source,
            annotationId: resolvedComment.annotationId ?? null,
            uid: resolvedComment.uid ?? null,
            id: resolvedComment.id,
            pageNumber,
            candidateIds,
        });

        const shouldAttemptPopupMode = () => (
            resolvedComment.source === 'pdf' || Boolean(resolvedComment.annotationId)
        );
        const refreshDeleteTargetFromSync = async () => {
            await commentSync.syncAnnotationComments();
            const syncedMatch =
                resolveCommentForDelete(resolvedComment) ??
                resolveCommentForDelete(comment);
            if (!syncedMatch) {
                return;
            }
            resolvedComment = syncedMatch;
            pageNumber = Math.max(
                1,
                Math.min(resolvedComment.pageNumber, numPages.value),
            );
            pageIndex = Math.max(0, pageNumber - 1);
            candidateIds = getCommentCandidateIds(resolvedComment);
        };

        let editor = findEditorForComment(resolvedComment);
        let switchedToPopupMode = false;
        const previousMode = uiManager.getMode();

        if (!editor) {
            await refreshDeleteTargetFromSync();
            editor =
                findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (
            !editor
            && shouldAttemptPopupMode()
            && previousMode !== AnnotationEditorType.POPUP
        ) {
            const switchError = await toolManager.updateModeWithRetry(
                uiManager,
                AnnotationEditorType.POPUP,
                pageNumber,
            );
            if (!switchError) {
                switchedToPopupMode = true;
            }
        }

        if (!editor) {
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch (waitError) {
                logCrudDebug(
                    'Timed out waiting for editors before comment delete',
                    waitError,
                );
            }
            editor =
                findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (
            !editor
            && candidateIds.length > 0
            && typeof managerWithCommentSelection.getEditor === 'function'
        ) {
            for (const id of candidateIds) {
                const byGlobalId = managerWithCommentSelection.getEditor(id);
                if (byGlobalId) {
                    editor = byGlobalId as IPdfjsEditor;
                    break;
                }
            }
        }

        if (!editor && candidateIds.length > 0) {
            for (const id of candidateIds) {
                const fromLayer = managerWithCommentSelection
                    .getLayer?.(pageIndex)
                    ?.getEditorByUID?.(id);
                if (fromLayer) {
                    editor = fromLayer;
                    break;
                }
            }
        }

        let attemptedCommentSelection = false;
        if (
            !editor &&
            candidateIds.length > 0 &&
            typeof managerWithCommentSelection.selectComment === 'function'
        ) {
            for (const id of candidateIds) {
                managerWithCommentSelection.selectComment(pageIndex, id);
                attemptedCommentSelection = true;
            }
            await nextTick();
            editor =
                findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && shouldAttemptPopupMode() && resolvedComment.annotationId) {
            const annotationStorage = pdfDocument.value?.annotationStorage as
        | { getEditor?: (annotationElementId: string) => IPdfjsEditor | null }
        | undefined;
            editor =
                annotationStorage?.getEditor?.(resolvedComment.annotationId) ?? null;
        }

        if (!editor && shouldAttemptPopupMode() && resolvedComment.annotationId) {
            editor = findEditorByAnnotationElementId(
                pageIndex,
                resolvedComment.annotationId,
            );
        }

        if (!editor) {
            editor = findEditorByMarkerRect(resolvedComment, pageIndex);
        }

        let deletedViaSelectionFallback = false;
        if (!editor && attemptedCommentSelection) {
            try {
                uiManager.delete();
                deletedViaSelectionFallback = true;
            } catch (selectionDeleteError) {
                logCrudDebug(
                    'uiManager.delete failed for selected comment fallback',
                    selectionDeleteError,
                );
            }
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
                previousMode,
                currentMode: uiManager.getMode(),
            });
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(
                    uiManager,
                    previousMode,
                    pageNumber,
                );
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
                uiManager.setSelected(editor as TUiManagerSelectedEditor);
                uiManager.delete();
                deleted = true;
            }
        } catch (deleteError) {
            logCrudDebug(
                'uiManager.delete failed for annotation comment',
                deleteError,
            );
            try {
                editor?.remove?.();
                deleted = true;
            } catch (removeError) {
                logCrudDebug(
                    'editor.remove failed for annotation comment',
                    removeError,
                );
                try {
                    editor?.delete?.();
                    deleted = true;
                } catch (legacyDeleteError) {
                    logCrudDebug(
                        'editor.delete fallback failed for annotation comment',
                        legacyDeleteError,
                    );
                    deleted = false;
                }
            }
        } finally {
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(
                    uiManager,
                    previousMode,
                    pageNumber,
                );
            }
        }

        if (!deleted) {
            BrowserLogger.warn('annotations', 'deleteAnnotationComment: editor delete failed', {
                stableKey: resolvedComment.stableKey,
                source: resolvedComment.source,
                annotationId: resolvedComment.annotationId ?? null,
                uid: resolvedComment.uid ?? null,
                id: resolvedComment.id,
            });
            return false;
        }

        if (pendingKey) {
            commentSync.pendingCommentEditorKeys.delete(pendingKey);
        } else if (candidateIds.length > 0) {
            for (const key of Array.from(commentSync.pendingCommentEditorKeys)) {
                if (candidateIds.some(candidate => key.endsWith(`:${candidate}`))) {
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

    function findEditorFromTarget(
        target: HTMLElement,
    ): IEditorTargetMatch | null {
        return findEditorFromTargetHelper(
            annotationUiManager.value,
            target,
            currentPage.value,
        );
    }

    function findEditorSummaryFromTarget(target: HTMLElement) {
        const match = findEditorFromTarget(target);
        if (!match) {
            return null;
        }

        const summary = commentSync.toEditorSummary(
            match.editor,
            match.pageIndex,
            getCommentText(match.editor),
        );
        const normalizedSummary = {
            ...identity.hydrateSummaryFromMemory(summary),
            annotationId: summary.annotationId ?? match.targetAnnotationId,
            stableKey: identity.computeSummaryStableKey({
                id: summary.id,
                pageIndex: summary.pageIndex,
                source: summary.source,
                uid: summary.uid,
                annotationId: summary.annotationId ?? match.targetAnnotationId,
            }),
        };
        const candidateIds = [
            normalizedSummary.annotationId,
            normalizedSummary.uid,
            normalizedSummary.id,
        ]
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .filter((id, index, arr) => arr.indexOf(id) === index);

        const cached =
            commentSync.annotationCommentsCache.value.find(
                (c) =>
                    c.pageIndex === match.pageIndex &&
          (candidateIds.includes(c.annotationId ?? '') ||
            candidateIds.includes(c.uid ?? '') ||
            candidateIds.includes(c.id)),
            ) ??
      commentSync.annotationCommentsCache.value.find(
          (c) =>
              candidateIds.includes(c.annotationId ?? '') ||
          candidateIds.includes(c.uid ?? '') ||
          candidateIds.includes(c.id),
      ) ??
      null;

        return cached ?? identity.hydrateSummaryFromMemory(normalizedSummary);
    }

    function findAnnotationSummaryFromTarget(target: HTMLElement) {
        const editorSummary = findEditorSummaryFromTarget(target);
        const pdfSummary = findPdfAnnotationSummaryFromTarget(
            target,
            currentPage.value,
            commentSync.annotationCommentsCache.value,
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

    function findAnnotationSummaryFromPoint(
        target: HTMLElement,
        clientX: number,
        clientY: number,
    ) {
        return findAnnotationSummaryFromPointHelper(
            target,
            clientX,
            clientY,
            currentPage.value,
            commentSync.annotationCommentsCache.value,
            highlight.findPageContainerFromClientPoint,
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

        const layerClass =
            match.editor.div?.closest<HTMLElement>(
                '.annotationEditorLayer, .annotation-editor-layer',
            )?.className ?? '';
        const isNonEditing = layerClass.includes('nonEditing');
        if (!isNonEditing) {
            return false;
        }

        const mode =
            activeTool === 'text'
                ? AnnotationEditorType.FREETEXT
                : AnnotationEditorType.POPUP;
        const modeError = await toolManager.updateModeWithRetry(
            uiManager,
            mode,
            match.pageIndex + 1,
        );
        if (modeError) {
            BrowserLogger.warn(
                'annotations',
                `Failed to enable editor interaction mode: ${errorToLogText(modeError)}`,
            );
            return false;
        }

        uiManager.setSelected(match.editor as TUiManagerSelectedEditor);
        freeTextResize.ensureFreeTextEditorCanResize(match.editor);
        return true;
    }

    function resolveCommentFromIndicatorClickTarget(
        target: HTMLElement,
        clientX: number,
        clientY: number,
    ) {
        const customIndicator = target.closest<HTMLElement>(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker',
        );
        if (customIndicator) {
            const inlineTarget = customIndicator.closest<HTMLElement>(
                '.pdf-annotation-has-note-target, .pdf-annotation-has-comment',
            );
            return (
                inlineIndicators.resolveCommentFromIndicatorElement(customIndicator) ??
        (inlineTarget
            ? inlineIndicators.findCommentFromInlineTarget(inlineTarget)
            : null) ??
        findAnnotationSummaryFromTarget(customIndicator) ??
        findAnnotationSummaryFromPoint(customIndicator, clientX, clientY)
            );
        }

        const popupTrigger = target.closest<HTMLElement>(
            '.annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        );
        if (popupTrigger) {
            return (
                findAnnotationSummaryFromTarget(popupTrigger) ??
        findAnnotationSummaryFromPoint(popupTrigger, clientX, clientY)
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

        const summary =
            findAnnotationSummaryFromTarget(explicitCommentTrigger) ??
      findAnnotationSummaryFromPoint(
          explicitCommentTrigger,
          event.clientX,
          event.clientY,
      );
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            emitAnnotationOpenNote(summary);
        }
    }

    async function handleAnnotationCommentClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        if (highlight.isPlacingComment.value) {
            runGuardedTask(
                () => highlight.placeCommentAtClientPoint(event.clientX, event.clientY),
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
            setActiveCommentAndSync(indicatorSummary.stableKey);
            inlineIndicators.pulseCommentIndicator(indicatorSummary.stableKey);
            emitAnnotationOpenNote(indicatorSummary);
            return;
        }

        if (annotationTool.value !== 'none') {
            if (annotationTool.value === 'text') {
                await ensureEditorInteractionModeFromTarget(event.target);
            }
            return;
        }
        if (
            event.target.closest(
                '.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog',
            )
        ) {
            return;
        }

        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
            return;
        }

        await ensureEditorInteractionModeFromTarget(event.target);

        const inlineTarget = event.target.closest<HTMLElement>(
            '.pdf-annotation-has-note-target, .pdf-annotation-has-comment',
        );
        if (inlineTarget) {
            const summary =
                inlineIndicators.findCommentFromInlineTarget(inlineTarget);
            if (summary) {
                setActiveCommentAndSync(summary.stableKey);
                inlineIndicators.pulseCommentIndicator(summary.stableKey);
                emitAnnotationCommentClick(summary);
                return;
            }
        }

        const summary =
            findAnnotationSummaryFromTarget(event.target) ??
      findAnnotationSummaryFromPoint(
          event.target,
          event.clientX,
          event.clientY,
      );
        if (!summary) {
            return;
        }
        setActiveCommentAndSync(summary.stableKey);
        inlineIndicators.pulseCommentIndicator(summary.stableKey);
        emitAnnotationCommentClick(summary);
    }

    function handleAnnotationCommentContextMenu(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

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
        const summary =
            (inlineTarget
                ? inlineIndicators.findCommentFromInlineTarget(inlineTarget)
                : null) ??
      findAnnotationSummaryFromTarget(event.target) ??
      findAnnotationSummaryFromPoint(
          event.target,
          event.clientX,
          event.clientY,
      );

        event.preventDefault();
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            inlineIndicators.pulseCommentIndicator(summary.stableKey);
        } else {
            setActiveCommentAndSync(null);
        }
        emitAnnotationContextMenu(
            highlight.buildAnnotationContextMenuPayload(
                summary,
                event.clientX,
                event.clientY,
            ),
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
