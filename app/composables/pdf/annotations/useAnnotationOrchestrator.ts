import type {
    Ref,
    ShallowRef,
    ComputedRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    ILinkAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { groupBy } from 'es-toolkit/array';
import { useAnnotationIdentity } from '@app/composables/pdf/annotations/useAnnotationIdentity';
import { useAnnotationSync } from '@app/composables/pdf/annotations/useAnnotationSync';
import { useAnnotationEditorBridge } from '@app/composables/pdf/annotations/useAnnotationEditorBridge';
import { useAnnotationToolState } from '@app/composables/pdf/annotations/useAnnotationToolState';
import { useAnnotationHighlight } from '@app/composables/pdf/annotations/useAnnotationHighlight';
import { useAnnotationCrud } from '@app/composables/pdf/annotations/useAnnotationCrud';
import { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';
import { useAnnotationMarkerViewModel } from '@app/composables/pdf/annotations/useAnnotationMarkerViewModel';

interface IUseAnnotationOrchestratorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number 
    }>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    authorName: Ref<string | null | undefined>;
    stopDrag: () => void;
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
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: (payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export const useAnnotationOrchestrator = (options: IUseAnnotationOrchestratorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        visibleRange,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        annotationUiManager,
        annotationL10n,
        annotationCommentsCache,
        activeCommentStableKey,
        authorName,
        stopDrag,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationComments,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        emitAnnotationToolAutoReset,
        emitAnnotationSetting,
        emitAnnotationCommentClick,
        emitAnnotationToolCancel,
        emitAnnotationNotePlacementChange,
    } = options;

    const identity = useAnnotationIdentity(annotationCommentsCache);

    const linkAnnotations = ref<ILinkAnnotation[]>([]);
    const linksByPage = computed(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );

    const freeTextResize = useFreeTextResize({
        getAnnotationUiManager: () => annotationUiManager.value,
        getNumPages: () => numPages.value,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync: () => commentSync.scheduleAnnotationCommentsSync(),
    });

    const toolState = useAnnotationToolState({
        annotationUiManager,
        currentPage,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        numPages,
        getEditorIdentity: identity.getEditorIdentity,
        getFreeTextResize: () => freeTextResize,
        emitAnnotationToolAutoReset,
    });

    const bridge = useAnnotationEditorBridge({
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationUiManager,
        annotationL10n,
        getIdentity: () => identity,
        getCommentSync: () => commentSync,
        getToolManager: () => toolState,
        getMarkupSubtype: () => toolState,
        getFreeTextResize: () => freeTextResize,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
    });

    const editor = {
        ...bridge,
        markupSubtype: toolState,
        toolManager: toolState,
        freeTextResize,
        setAnnotationTool: toolState.setAnnotationTool,
        applyAnnotationSettings: toolState.applyAnnotationSettings,
        updateModeWithRetry: toolState.updateModeWithRetry,
        getMarkupSubtypeOverrides: toolState.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: toolState.getMarkupSubtypeHints,
        ensureFreeTextEditorCanResize: freeTextResize.ensureFreeTextEditorCanResize,
    };

    const commentSync = useAnnotationSync({
        pdfDocument,
        numPages,
        currentPage,
        annotationUiManager,
        authorName,
        getIdentity: () => identity,
        getMarkupSubtype: () => toolState,
        getStore: () => ({
            setAnnotations: (comments: IAnnotationCommentSummary[]) => {
                annotationCommentsCache.value = comments;
                emitAnnotationComments(comments);
            },
            setLinkAnnotations: (links: ILinkAnnotation[]) => {
                linkAnnotations.value = links;
            },
            setActiveKey: (key: string | null) => {
                activeCommentStableKey.value = key;
            },
        }),
        syncInlineCommentIndicators: () => inlineIndicators.syncInlineCommentIndicators(),
    });

    const {
        markersByPage,
        inlineIndicators,
    } = useAnnotationMarkerViewModel({
        viewerContainer,
        annotationCommentsCache,
        activeCommentStableKey,
    });

    const highlight = useAnnotationHighlight({
        viewerContainer,
        annotationUiManager,
        numPages,
        currentPage,
        annotationTool,
        getIdentity: () => identity,
        getMarkupSubtype: () => toolState,
        getSync: () => commentSync,
        getToolManager: () => toolState,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    });

    const crud = useAnnotationCrud({
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
        visibleRange,
        annotationTool,
        annotationCommentsCache,
        getIdentity: () => identity,
        getSync: () => commentSync,
        getFreeTextResize: () => freeTextResize,
        getToolManager: () => toolState,
        getInlineIndicators: () => inlineIndicators,
        getHighlight: () => highlight,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationOpenNote,
        emitAnnotationCommentClick,
        emitAnnotationContextMenu,
        emitAnnotationToolCancel,
    });

    return {
        identity,
        editor,
        commentSync,
        inlineIndicators,
        markersByPage,
        linksByPage,
        highlight,
        crud,
    };
};
