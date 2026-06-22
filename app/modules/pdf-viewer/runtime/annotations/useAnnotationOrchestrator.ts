import type {
    ComputedRef,
    Ref,
    ShallowRef,
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
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { groupBy } from 'es-toolkit/array';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationIdentity';
import { useAnnotationSync } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationSync';
import { useAnnotationEditorBridge } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationEditorBridge';
import { useAnnotationToolState } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationToolState';
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight';
import { useAnnotationCrud } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud';
import { useFreeTextResize } from '@app/modules/pdf-viewer/runtime/annotations/useFreeTextResize';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';

interface IUseAnnotationOrchestratorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    markerGeometryVersion?: Ref<number> | undefined;
    authorName: Ref<string | null | undefined>;
    stopDrag: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    renderVisiblePages: (
        range: {
            start: number;
            end: number 
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    renderAnnotationEditorLayerForPage?: (pageNumber: number) => Promise<boolean>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    recordPdfjsHistoryCommand?: (params: {
        type?: number;
        overwriteIfSameType?: boolean;
    }) => void;
    recordPdfjsHistoryClean?: (type: number) => void;
    recordPdfjsHistoryUndo?: () => void;
    recordPdfjsHistoryRedo?: () => void;
    discardPdfjsHistory?: () => void;
    isPdfjsHistoryRouted?: () => boolean;
    routeAnnotationHistoryUndo?: () => boolean;
    routeAnnotationHistoryRedo?: () => boolean;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary[] | undefined;
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
    const { t } = useTypedI18n();

    const {
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationKeepActive,
        annotationSettings,
        annotationUiManager,
        annotationL10n,
        annotationCommentsCache,
        activeCommentStableKey,
        markerGeometryVersion,
        authorName,
        stopDrag,
        scrollToPage,
        renderVisiblePages,
        renderAnnotationEditorLayerForPage,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationState,
        recordPdfjsHistoryCommand,
        recordPdfjsHistoryClean,
        recordPdfjsHistoryUndo,
        recordPdfjsHistoryRedo,
        discardPdfjsHistory,
        isPdfjsHistoryRouted,
        routeAnnotationHistoryUndo,
        routeAnnotationHistoryRedo,
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
        ...(recordPdfjsHistoryCommand ? { recordPdfjsHistoryCommand } : {}),
        ...(recordPdfjsHistoryClean ? { recordPdfjsHistoryClean } : {}),
        ...(recordPdfjsHistoryUndo ? { recordPdfjsHistoryUndo } : {}),
        ...(recordPdfjsHistoryRedo ? { recordPdfjsHistoryRedo } : {}),
        ...(discardPdfjsHistory ? { discardPdfjsHistory } : {}),
        ...(isPdfjsHistoryRouted ? { isPdfjsHistoryRouted } : {}),
        ...(routeAnnotationHistoryUndo ? { routeAnnotationHistoryUndo } : {}),
        ...(routeAnnotationHistoryRedo ? { routeAnnotationHistoryRedo } : {}),
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
            setAnnotations: (comments) => {
                const appliedComments = emitAnnotationComments(comments) ?? comments;
                annotationCommentsCache.value = appliedComments;
                return appliedComments;
            },
            setLinkAnnotations: (links) => {
                linkAnnotations.value = links;
            },
            setActiveKey: (key) => {
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
        markerGeometryVersion,
        labels: {
            annotation: t('annotations.annotationLabel'),
            note: t('annotations.stickyNoteLabel'),
            moreNotes: count => t('annotations.moreNotes', { count }),
        },
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
        deferCreatedEditorUndoToStorage: true,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
        ensureAnnotationEditorLayerReady: async (pageNumber) => {
            if (await renderAnnotationEditorLayerForPage?.(pageNumber)) {
                return;
            }
            await renderVisiblePages(
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
        },
    });

    const crud = useAnnotationCrud({
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
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
