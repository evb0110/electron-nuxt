import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { removeAnnotationCommentDom } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom';
import type { ITextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IAnnotationMutationVisualEffect,
    IAnnotationMutationVisualEffectsState,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';
import { tryOnScopeDispose } from '@vueuse/core';

interface IUseAnnotationMutationVisualEffectsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    textMarkupPresentation: ITextMarkupPresentationController;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    invalidatePages: (pages: number[]) => void;
    visualEffects: IAnnotationMutationVisualEffectsState;
}

export const useAnnotationMutationVisualEffects = (options: IUseAnnotationMutationVisualEffectsOptions) => {
    let isFlushing = false;
    let lastConsumedEffectId = 0;
    let disposed = false;

    function resolveComment(effect: IAnnotationMutationVisualEffect, preferSnapshot = false) {
        if (preferSnapshot && effect.commentSnapshot) {
            return effect.commentSnapshot;
        }
        const stableKey = effect.stableKey?.trim();
        if (stableKey) {
            const byStableKey = options.annotationCommentsCache.value.find(comment => comment.stableKey === stableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }
        const annotationId = normalizePdfJsAnnotationId(effect.annotationId);
        if (annotationId) {
            const byAnnotationId = options.annotationCommentsCache.value.find(comment =>
                normalizePdfJsAnnotationId(comment.annotationId) === annotationId,
            );
            if (byAnnotationId) {
                return byAnnotationId;
            }
        }
        return effect.commentSnapshot ?? null;
    }

    // Colour resolution and DOM application belong to the text-markup presentation
    // controller; a mutation only hands it the resolved intent.
    function applyTextMarkupColorEffect(effect: IAnnotationMutationVisualEffect) {
        const comment = resolveComment(effect);
        if (!comment) {
            return;
        }
        options.textMarkupPresentation.notify({
            kind: 'comment-color-mutated',
            color: effect.color ?? comment.color ?? null,
            comment,
            sourceColor: effect.sourceColor ?? effect.commentSnapshot?.color ?? null,
        });
    }

    async function renderPageTextMarkupEffect(effect: IAnnotationMutationVisualEffect) {
        const comment = resolveComment(effect);
        const pageNumber = Math.floor(effect.pageNumber ?? comment?.pageNumber ?? 0);
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
            return;
        }
        await options.renderVisiblePages(
            {
                start: pageNumber,
                end: pageNumber,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    }

    function applyAnnotationDomRemovalEffect(effect: IAnnotationMutationVisualEffect) {
        const container = options.viewerContainer.value;
        const comment = resolveComment(effect, true);
        if (!container || !comment) {
            return;
        }
        removeAnnotationCommentDom(container, comment);
        const pageNumber = Math.floor(effect.pageNumber ?? comment.pageNumber);
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
            // Annotation-layer invalidation also advances the thumbnail layer
            // revision, preventing deleted markup from surviving in a
            // previously rendered thumbnail canvas.
            options.invalidatePages([pageNumber]);
        }
    }

    async function applyEffect(effect: IAnnotationMutationVisualEffect) {
        if (disposed) {
            return false;
        }
        try {
            if (effect.kind === 'text-markup-color') {
                applyTextMarkupColorEffect(effect);
            } else if (effect.kind === 'render-page-text-markup') {
                await renderPageTextMarkupEffect(effect);
            } else {
                applyAnnotationDomRemovalEffect(effect);
            }
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to apply annotation visual mutation effect', error);
        }
        return !disposed;
    }

    async function flushVisualEffects() {
        if (isFlushing) {
            return;
        }
        isFlushing = true;
        try {
            for (;;) {
                const pendingEffects = options.visualEffects.effects.value
                    .filter(effect => effect.id > lastConsumedEffectId);
                if (pendingEffects.length === 0) {
                    return;
                }
                for (const effect of pendingEffects) {
                    if (!await applyEffect(effect)) {
                        return;
                    }
                    lastConsumedEffectId = Math.max(lastConsumedEffectId, effect.id);
                }
                if (disposed) {
                    return;
                }
                options.visualEffects.consumeThrough(lastConsumedEffectId);
            }
        } finally {
            isFlushing = false;
            if (!disposed && options.visualEffects.effects.value.some(effect => effect.id > lastConsumedEffectId)) {
                void flushVisualEffects();
            }
        }
    }

    watch(
        options.visualEffects.version,
        () => {
            void nextTick().then(async () => {
                if (disposed) {
                    return;
                }
                await flushVisualEffects();
            });
        },
        { immediate: true },
    );

    tryOnScopeDispose(() => {
        disposed = true;
    });

    return { flushVisualEffects };
};
