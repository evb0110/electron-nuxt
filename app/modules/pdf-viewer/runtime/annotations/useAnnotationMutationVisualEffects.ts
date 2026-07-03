import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { applyAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { applyAnnotationCommentTextMarkupVisualOverlay } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay';
import { removeAnnotationCommentDom } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IAnnotationMutationVisualEffect,
    IAnnotationMutationVisualEffectsState,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';

interface IUseAnnotationMutationVisualEffectsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
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
    visualEffects: IAnnotationMutationVisualEffectsState;
}

function isHighlightComment(comment: IAnnotationCommentSummary) {
    return (comment.subtype ?? '').trim().toLowerCase() === 'highlight';
}

export const useAnnotationMutationVisualEffects = (options: IUseAnnotationMutationVisualEffectsOptions) => {
    let isFlushing = false;
    let lastConsumedEffectId = 0;

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

    function resolveColor(effect: IAnnotationMutationVisualEffect, comment: IAnnotationCommentSummary) {
        const color = (effect.color ?? comment.color)?.trim();
        return color && color.length > 0 ? color : null;
    }

    function resolveDisplayColor(effect: IAnnotationMutationVisualEffect, comment: IAnnotationCommentSummary) {
        const color = resolveColor(effect, comment);
        if (!color) {
            return null;
        }
        if (!isHighlightComment(comment)) {
            return color;
        }
        return toOpaqueHighlightDisplayColor(
            color,
            options.annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
        );
    }

    function resolveHighlightOpacity(comment: IAnnotationCommentSummary) {
        return isHighlightComment(comment)
            ? options.annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity
            : null;
    }

    function applyTextMarkupColorEffect(effect: IAnnotationMutationVisualEffect) {
        const container = options.viewerContainer.value;
        const comment = resolveComment(effect);
        if (!container || !comment) {
            return;
        }
        const displayColor = resolveDisplayColor(effect, comment);
        const overlayColor = resolveColor(effect, comment);
        if (displayColor) {
            applyAnnotationCommentTextMarkupColor(
                container,
                comment,
                displayColor,
                {
                    sourceColor: effect.sourceColor ?? effect.commentSnapshot?.color ?? null,
                    suppressNativeTextMarkupDecoration: true,
                },
            );
        }
        if (overlayColor) {
            applyAnnotationCommentTextMarkupVisualOverlay(
                container,
                comment,
                overlayColor,
                { highlightOpacity: resolveHighlightOpacity(comment) },
            );
        }
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
    }

    async function applyEffect(effect: IAnnotationMutationVisualEffect) {
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
                    await applyEffect(effect);
                    lastConsumedEffectId = Math.max(lastConsumedEffectId, effect.id);
                }
                options.visualEffects.consumeThrough(lastConsumedEffectId);
            }
        } finally {
            isFlushing = false;
            if (options.visualEffects.effects.value.some(effect => effect.id > lastConsumedEffectId)) {
                void flushVisualEffects();
            }
        }
    }

    watch(
        options.visualEffects.version,
        () => {
            void nextTick().then(flushVisualEffects);
        },
        { immediate: true },
    );

    return { flushVisualEffects };
};
