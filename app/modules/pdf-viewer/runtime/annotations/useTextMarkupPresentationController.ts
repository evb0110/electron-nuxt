import type {
    ComputedRef,
    Ref,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { applyAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { applyAnnotationCommentTextMarkupVisualOverlay } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay';
import { syncAnnotationCommentTextMarkupVisualOverlays } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/syncAnnotationCommentTextMarkupVisualOverlays';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';

const PRESENTATION_ESCALATION_DELAYS_MS = [
    50,
    100,
    200,
    400,
    800,
] as const;

interface ITextMarkupEditorPresentation {pageNumber: number;}

interface ITextMarkupEditorPresentationRead<TEditorPresentation extends ITextMarkupEditorPresentation> {
    editors: readonly TEditorPresentation[];
    unresolvedPageNumbers: readonly number[];
}

export type TTextMarkupPresentationSignal =
    | {
        kind: 'comment-color-mutated';
        color: string | null;
        comment: IAnnotationCommentSummary;
        sourceColor: string | null;
    }
    | { kind: 'document-invalidated' }
    | {
        editor: object;
        kind: 'editor-presentation-cleared';
    }
    | { kind: 'editors-changed' }
    | {
        kind: 'page-layer-committed';
        pageNumber: number;
    };

type TCommentColorMutation = Extract<TTextMarkupPresentationSignal, {kind: 'comment-color-mutated'}>;

export interface ITextMarkupPresentationController {notify: (signal: TTextMarkupPresentationSignal) => void;}

interface IUseTextMarkupPresentationControllerOptions<TEditorPresentation extends ITextMarkupEditorPresentation> {
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    clearEditorPresentation: (editor: object) => void;
    effectiveScale: Ref<number>;
    isActive: ComputedRef<boolean>;
    presentEditor: (editor: TEditorPresentation) => boolean;
    readEditorPresentation: (
        pageNumbers?: readonly number[],
    ) => ITextMarkupEditorPresentationRead<TEditorPresentation>;
    resetEditorPresentation: () => void;
    viewerContainer: Ref<HTMLElement | null>;
}

function isHighlightComment(comment: IAnnotationCommentSummary) {
    return (comment.subtype ?? '').trim().toLowerCase() === 'highlight';
}

function isRepairableTextMarkupComment(comment: IAnnotationCommentSummary) {
    return comment.colorEdited === true && isTextMarkupSubtype(comment.subtype);
}

export const useTextMarkupPresentationController = <TEditorPresentation extends ITextMarkupEditorPresentation>(
    options: IUseTextMarkupPresentationControllerOptions<TEditorPresentation>,
): ITextMarkupPresentationController => {
    const supervisor = createPdfRenderSupervisor();
    const pendingPages = new Set<number>();
    const pendingMutations = new Map<string, TCommentColorMutation>();
    const firedAttemptsByPage = new Map<number, number>();
    const armedTimersByPage = new Map<number, IPdfRenderSupervisorTimer>();
    let pendingAllPages = false;
    let generation = 0;
    let frameHandle: number | null = null;
    let frameQueued = false;

    function resolveHighlightOpacity() {
        return options.annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity;
    }

    function resolveDisplayColor(comment: IAnnotationCommentSummary, color: string | null) {
        const normalized = color?.trim();
        if (!normalized) {
            return null;
        }
        return isHighlightComment(comment)
            ? toOpaqueHighlightDisplayColor(normalized, resolveHighlightOpacity())
            : normalized;
    }

    function resolveOverlayColor(comment: IAnnotationCommentSummary) {
        const color = comment.color?.trim();
        return color && color.length > 0 ? color : null;
    }

    function isPageSurfaceMounted(container: HTMLElement, pageNumber: number) {
        return Boolean(container.querySelector(
            `${pdfViewerDomSelectors.pageContainer}[data-page="${String(pageNumber)}"]`,
        ));
    }

    function clearEscalation(pageNumber: number, resetBudget = false) {
        supervisor.clearTimer(armedTimersByPage.get(pageNumber));
        armedTimersByPage.delete(pageNumber);
        if (resetBudget) {
            firedAttemptsByPage.delete(pageNumber);
        }
    }

    function clearAllEscalations() {
        Array.from(armedTimersByPage.keys()).forEach(pageNumber => clearEscalation(pageNumber));
        firedAttemptsByPage.clear();
    }

    function escalate(pageNumber: number) {
        if (!options.isActive.value || armedTimersByPage.has(pageNumber)) {
            return;
        }
        const attempt = firedAttemptsByPage.get(pageNumber) ?? 0;
        const delayMs = PRESENTATION_ESCALATION_DELAYS_MS[attempt];
        if (delayMs === undefined) {
            return;
        }
        const timerGeneration = generation;
        armedTimersByPage.set(pageNumber, supervisor.armTimer({
            cause: 'text-markup-presentation-repair',
            delayMs,
            key: `text-markup-presentation:${String(pageNumber)}`,
            metadata: {
                attempt: attempt + 1,
                pageNumber,
            },
            onFire: () => {
                armedTimersByPage.delete(pageNumber);
                if (!options.isActive.value || timerGeneration !== generation) {
                    return;
                }
                firedAttemptsByPage.set(pageNumber, attempt + 1);
                pendingPages.add(pageNumber);
                scheduleFrame();
            },
        }));
    }

    function applyCommentColor(
        container: HTMLElement,
        comment: IAnnotationCommentSummary,
        color: string | null,
        sourceColor?: string | null,
    ) {
        const displayColor = resolveDisplayColor(comment, color);
        const applied = !displayColor || applyAnnotationCommentTextMarkupColor(
            container,
            comment,
            displayColor,
            {
                ...(sourceColor !== undefined ? {sourceColor} : {}),
                suppressNativeTextMarkupDecoration: true,
            },
        );
        return !applied && isPageSurfaceMounted(container, comment.pageNumber)
            ? comment.pageNumber
            : null;
    }

    function applyPresentation(
        container: HTMLElement,
        pageNumber: number | null,
        mutations: Map<string, TCommentColorMutation>,
    ) {
        const unresolvedPages = new Set<number>();
        const comments = options.annotationCommentsCache.value;
        const foldedMutations = new Map<string, TCommentColorMutation>();
        for (const comment of comments) {
            if (
                !isRepairableTextMarkupComment(comment)
                || (pageNumber !== null && comment.pageNumber !== pageNumber)
                || !isPageSurfaceMounted(container, comment.pageNumber)
            ) {
                continue;
            }
            const mutation = mutations.get(comment.stableKey);
            const unresolvedPage = applyCommentColor(
                container,
                comment,
                mutation?.color ?? comment.color ?? null,
                mutation?.sourceColor,
            );
            if (unresolvedPage !== null) unresolvedPages.add(unresolvedPage);
            if (mutation) foldedMutations.set(comment.stableKey, mutation);
            mutations.delete(comment.stableKey);
        }

        syncAnnotationCommentTextMarkupVisualOverlays(container, comments, {
            ...(pageNumber === null ? {} : {pageNumber}),
            resolveColor: (comment) => {
                const mutationColor = foldedMutations.get(comment.stableKey)?.color?.trim();
                return mutationColor?.length ? mutationColor : resolveOverlayColor(comment);
            },
            resolveHighlightOpacity: comment => isHighlightComment(comment)
                ? resolveHighlightOpacity()
                : null,
        });

        const editorRead = options.readEditorPresentation(
            pageNumber === null ? undefined : [pageNumber],
        );
        editorRead.unresolvedPageNumbers.forEach(unresolvedPage => unresolvedPages.add(unresolvedPage));
        editorRead.editors.forEach((entry) => {
            if (!options.presentEditor(entry)) {
                unresolvedPages.add(entry.pageNumber);
            }
        });
        return unresolvedPages;
    }

    function applyCommentColorMutation(
        container: HTMLElement,
        signal: TCommentColorMutation,
    ) {
        const unresolvedPage = applyCommentColor(
            container,
            signal.comment,
            signal.color,
            signal.sourceColor,
        );
        const overlayColor = signal.color?.trim();
        if (overlayColor) {
            applyAnnotationCommentTextMarkupVisualOverlay(
                container,
                signal.comment,
                overlayColor,
                { highlightOpacity: isHighlightComment(signal.comment) ? resolveHighlightOpacity() : null },
            );
        }
        return unresolvedPage;
    }

    function runFrame(frameGeneration: number) {
        frameHandle = null;
        frameQueued = false;
        if (!options.isActive.value || frameGeneration !== generation) {
            return;
        }
        const applyAllPages = pendingAllPages;
        const pages = Array.from(pendingPages);
        const mutations = new Map(pendingMutations);
        pendingAllPages = false;
        pendingPages.clear();
        pendingMutations.clear();

        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        const unresolvedPages = applyAllPages
            ? applyPresentation(container, null, mutations)
            : pages.reduce((accumulated, pageNumber) => {
                applyPresentation(container, pageNumber, mutations).forEach(page => accumulated.add(page));
                return accumulated;
            }, new Set<number>());
        mutations.forEach((mutation) => {
            const unresolvedPage = applyCommentColorMutation(container, mutation);
            if (unresolvedPage !== null) {
                unresolvedPages.add(unresolvedPage);
            }
        });

        const attemptedPages = applyAllPages
            ? new Set([
                ...firedAttemptsByPage.keys(),
                ...armedTimersByPage.keys(),
            ])
            : new Set([
                ...pages,
                ...Array.from(mutations.values(), mutation => mutation.comment.pageNumber),
            ]);
        attemptedPages.forEach((pageNumber) => {
            if (!unresolvedPages.has(pageNumber)) {
                clearEscalation(pageNumber, true);
            }
        });
        unresolvedPages.forEach((pageNumber) => {
            if (isPageSurfaceMounted(container, pageNumber)) {
                escalate(pageNumber);
            }
        });
    }

    function scheduleFrame() {
        if (!options.isActive.value || frameQueued) {
            return;
        }
        frameQueued = true;
        const frameGeneration = generation;
        if (typeof requestAnimationFrame === 'function') {
            frameHandle = requestAnimationFrame(() => runFrame(frameGeneration));
            return;
        }
        queueMicrotask(() => runFrame(frameGeneration));
    }

    function cancelFrame() {
        if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(frameHandle);
        }
        frameHandle = null;
        frameQueued = false;
        pendingAllPages = false;
        pendingPages.clear();
        pendingMutations.clear();
    }

    function restartPresentation() {
        generation += 1;
        clearAllEscalations();
        cancelFrame();
        if (options.isActive.value && options.viewerContainer.value) {
            pendingAllPages = true;
            scheduleFrame();
        }
    }

    function notify(signal: TTextMarkupPresentationSignal) {
        if (signal.kind === 'document-invalidated') {
            generation += 1;
            clearAllEscalations();
            cancelFrame();
            options.resetEditorPresentation();
            return;
        }
        if (signal.kind === 'editor-presentation-cleared') {
            options.clearEditorPresentation(signal.editor);
            return;
        }
        if (!options.isActive.value) {
            return;
        }
        if (signal.kind === 'comment-color-mutated') {
            pendingMutations.set(signal.comment.stableKey, signal);
            scheduleFrame();
            return;
        }
        if (signal.kind === 'page-layer-committed') {
            clearEscalation(signal.pageNumber, true);
            pendingPages.add(signal.pageNumber);
            scheduleFrame();
            return;
        }
        pendingAllPages = true;
        scheduleFrame();
    }

    watch(options.effectiveScale, () => {
        if (options.isActive.value) {
            pendingAllPages = true;
            scheduleFrame();
        }
    });
    watch(
        () => options.annotationCommentsCache.value.map(comment => [
            comment.stableKey,
            comment.annotationId ?? '',
            comment.pageNumber,
            comment.subtype ?? '',
            comment.color ?? '',
            comment.colorEdited ? '1' : '0',
            comment.markerRect?.left ?? '',
            comment.markerRect?.top ?? '',
            comment.markerRect?.width ?? '',
            comment.markerRect?.height ?? '',
        ].join(':')),
        () => {
            if (options.isActive.value) {
                pendingAllPages = true;
                scheduleFrame();
            }
        },
    );
    watch(
        () => {
            const settings = options.annotationSettings.value;
            return settings ? Object.values(settings).join('|') : '';
        },
        () => {
            if (options.isActive.value) {
                restartPresentation();
            }
        },
    );
    watch(options.isActive, (isActive) => {
        if (isActive) {
            restartPresentation();
            return;
        }
        generation += 1;
        clearAllEscalations();
        cancelFrame();
    });
    watch(options.viewerContainer, (container) => {
        if (container && options.isActive.value) {
            restartPresentation();
            return;
        }
        generation += 1;
        clearAllEscalations();
        cancelFrame();
    });

    tryOnScopeDispose(() => {
        generation += 1;
        clearAllEscalations();
        cancelFrame();
        options.resetEditorPresentation();
    });

    return {notify};
};
