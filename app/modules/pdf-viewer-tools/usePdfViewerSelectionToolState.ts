import type {
    ComputedRef,
    Ref,
} from 'vue';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import {
    isSelectionInteractionTool,
    isSelectionMarkupTool,
} from '@app/composables/pdf/annotations/annotationRules';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';

interface IUsePdfViewerSelectionToolStateOptions {
    dragMode: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    pendingImagePlacement: Ref<unknown | null>;
}

export function usePdfViewerSelectionToolState(options: IUsePdfViewerSelectionToolStateOptions) {
    const isImagePlacementActive = computed(() => options.pendingImagePlacement.value !== null);
    const isViewerPanDragModeActive = computed(() => options.dragMode.value && !isImagePlacementActive.value);
    const isSelectionMarkupToolActive = computed(() => isSelectionMarkupTool(options.annotationTool.value));
    const isTextSelectionModeActive = computed(() =>
        options.annotationCursorMode.value
        && (
            options.annotationTool.value === 'none'
            || isSelectionInteractionTool(options.annotationTool.value)
        ),
    );
    const selectionMarkupStyle = computed(() => {
        if (!isSelectionMarkupToolActive.value) {
            return null;
        }
        const settings = options.annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS;
        const {
            color,
            opacity,
        } = (() => {
            if (options.annotationTool.value === 'underline') {
                return {
                    color: settings.underlineColor,
                    opacity: settings.underlineOpacity,
                };
            }
            if (options.annotationTool.value === 'strikethrough') {
                return {
                    color: settings.strikethroughColor,
                    opacity: settings.strikethroughOpacity,
                };
            }
            return {
                color: settings.highlightColor,
                opacity: settings.highlightOpacity,
            };
        })();
        const opacityPercent = Math.round(Math.max(0, Math.min(1, opacity)) * 100);
        return { '--app-pdf-text-selection-bg': `color-mix(in srgb, ${color} ${opacityPercent}%, transparent)` };
    });

    const drag = usePdfDrag(() => isViewerPanDragModeActive.value);
    watch(isImagePlacementActive, (active) => {
        if (active) {
            drag.stopDrag();
        }
    });

    return {
        isImagePlacementActive,
        isViewerPanDragModeActive,
        isSelectionMarkupToolActive,
        isTextSelectionModeActive,
        selectionMarkupStyle,
        isDragging: drag.isDragging,
        startDrag: drag.startDrag,
        onDrag: drag.onDrag,
        stopDrag: drag.stopDrag,
    };
}
