// PDF.js runtime wiring is isolated in the bridge; callers retain only ports.
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { PixelsPerInch } from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { useAnnotationHighlight } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight';
import type { useAnnotationToolState } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationToolState';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';

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
    annotations: {
        editor: Pick<
            ReturnType<typeof useAnnotationToolState>,
            'applyAnnotationSettings' | 'setAnnotationTool'
        >;
        highlight: Pick<
            ReturnType<typeof useAnnotationHighlight>,
            'cancelCommentPlacement'
        >;
    };
}

export const usePdfViewerAnnotationRuntimeBridge = (options: IUsePdfViewerAnnotationRuntimeBridgeOptions) => {
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
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    const annotationCommentIds = computed(() =>
        annotationCommentsCache.value.map(annotationIdForSummary),
    );
    watch(
        annotationCommentIds,
        (annotationIds) => {
            const activeKey = activeCommentStableKey.value;
            if (!activeKey) {
                return;
            }
            if (!annotationIds.some(annotationId => annotationId === activeKey)) {
                activeCommentStableKey.value = null;
            }
        },
    );

    watch(effectiveScale, (scale) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onScaleChanging({ scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS });
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
};
