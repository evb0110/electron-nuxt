import type {
    ComputedRef,
    Ref,
} from 'vue';
import { applyAnnotationCommentTextMarkupColor } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { syncAnnotationCommentTextMarkupVisualOverlays } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/syncAnnotationCommentTextMarkupVisualOverlays';
import { toOpaqueHighlightDisplayColor } from '@app/utils/pdf-viewer/text-markup-color/toOpaqueHighlightDisplayColor';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { collectEditedTextMarkupCanvasSuppressionIds } from '@app/modules/pdf-viewer/annotations/edited-text-markup-canvas-suppression/collectEditedTextMarkupCanvasSuppressionIds';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';

interface IEditedTextMarkupVisualSyncOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    hiddenEmbeddedAnnotationIds: ComputedRef<Set<string>>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
}

export function useEditedTextMarkupVisualSync(options: IEditedTextMarkupVisualSyncOptions) {
    const canvasHiddenAnnotationIds = computed(() => collectEditedTextMarkupCanvasSuppressionIds(
        options.annotationCommentsCache.value,
        options.hiddenEmbeddedAnnotationIds.value,
    ));

    function resolveRenderedTextMarkupColor(comment: IAnnotationCommentSummary) {
        if (!comment.color) {
            return null;
        }
        if ((comment.subtype ?? '').trim().toLowerCase() !== 'highlight') {
            return comment.color;
        }
        return toOpaqueHighlightDisplayColor(
            comment.color,
            options.annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
        );
    }

    function resolveRenderedTextMarkupOverlayColor(comment: IAnnotationCommentSummary) {
        return comment.color?.trim() || null;
    }

    function resolveRenderedTextMarkupHighlightOpacity(comment: IAnnotationCommentSummary) {
        if ((comment.subtype ?? '').trim().toLowerCase() !== 'highlight') {
            return null;
        }
        return options.annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity;
    }

    function applyEditedTextMarkupColorsForRenderedPage(pageNumber: number) {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        for (const comment of options.annotationCommentsCache.value) {
            if (
                comment.pageNumber !== pageNumber
                || comment.colorEdited !== true
                || !isTextMarkupSubtype(comment.subtype)
            ) {
                continue;
            }
            const color = resolveRenderedTextMarkupColor(comment);
            if (color) {
                applyAnnotationCommentTextMarkupColor(
                    container,
                    comment,
                    color,
                    { suppressNativeTextMarkupDecoration: true },
                );
            }
        }
        syncAnnotationCommentTextMarkupVisualOverlays(container, options.annotationCommentsCache.value, {
            pageNumber,
            resolveColor: resolveRenderedTextMarkupOverlayColor,
            resolveHighlightOpacity: resolveRenderedTextMarkupHighlightOpacity,
        });
    }

    return {
        canvasHiddenAnnotationIds,
        applyEditedTextMarkupColorsForRenderedPage,
    };
}
