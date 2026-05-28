import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import { PixelsPerInch } from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { runGuardedTask } from '@app/utils/asyncGuard';

type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;

interface IUsePdfViewerAnnotationRuntimeBridgeOptions {
    isActive: ComputedRef<boolean>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    annotations: TAnnotationOrchestrator;
}

export function usePdfViewerAnnotationRuntimeBridge(options: IUsePdfViewerAnnotationRuntimeBridgeOptions) {
    const {
        isActive,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        annotations,
    } = options;
    const {
        editor,
        highlight,
    } = annotations;

    function scheduleSetAnnotationTool(tool: TAnnotationTool, stage: string) {
        runGuardedTask(() => editor.setAnnotationTool(tool), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        () => {
            if (isActive.value) {
                highlight.cacheCurrentTextSelection();
            }
        },
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        (event) => {
            if (isActive.value && event instanceof PointerEvent) {
                highlight.handleDocumentPointerUp(event);
            }
        },
        { passive: true },
    );

    const annotationCommentStableKeys = computed(() =>
        annotationCommentsCache.value.map(comment => comment.stableKey),
    );
    watch(
        annotationCommentStableKeys,
        (stableKeys) => {
            const activeKey = activeCommentStableKey.value;
            if (!activeKey) {
                return;
            }
            if (!stableKeys.includes(activeKey)) {
                activeCommentStableKey.value = null;
            }
        },
    );

    watch(effectiveScale, (scale) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onScaleChanging({ scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS });
        const syncMarkupSubtypePresentation = () => {
            annotations.editor.markupSubtype.syncMarkupSubtypePresentationForEditors();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(syncMarkupSubtypePresentation);
        } else {
            queueMicrotask(syncMarkupSubtypePresentation);
        }
    });

    watch(currentPage, (page) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
    });

    watch(
        annotationTool,
        (tool) => {
            if (!isActive.value) {
                return;
            }
            if (tool !== 'none') {
                highlight.cancelCommentPlacement();
            }
            scheduleSetAnnotationTool(tool, `apply annotation tool "${tool}"`);
        },
        { immediate: true },
    );

    watch(annotationCursorMode, () => {
        if (!isActive.value) {
            return;
        }
        if (annotationTool.value === 'none') {
            scheduleSetAnnotationTool('none', 're-apply annotation cursor mode');
        }
    });

    const annotationSettingsSignature = computed(() => {
        const settings = annotationSettings.value;
        if (!settings) {
            return '';
        }
        return Object.values(settings).join('|');
    });
    watch(
        annotationSettingsSignature,
        () => {
            if (!isActive.value) {
                return;
            }
            editor.applyAnnotationSettings(annotationSettings.value);
        },
        { immediate: true },
    );

    return {scheduleSetAnnotationTool};
}
