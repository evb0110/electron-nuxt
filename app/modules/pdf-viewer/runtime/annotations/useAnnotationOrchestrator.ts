import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { TPdfjsAnnotationManager } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    ILinkAnnotation,
    TAnnotationTool,
    TAnnotationSettingChange,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { groupBy } from 'es-toolkit/array';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationIdentity';
import { useAnnotationSync } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationSync';
import { useAnnotationEditorBridge } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationEditorBridge';
import { useAnnotationToolState } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationToolState';
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight';
import { useAnnotationCrud } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud';
import { useFreeTextResize } from '@app/modules/pdf-viewer/runtime/annotations/useFreeTextResize';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';
import type { IPdfAnnotationRenderingPort } from '@app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort';

interface IUseAnnotationOrchestratorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    sourcePdf: ComputedRef<TPdfSource | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<TPdfjsAnnotationManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    markerGeometryVersion?: Ref<number> | undefined;
    authorName: Ref<string | null | undefined>;
    stopDrag: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    renderingPort: Pick<
        IPdfAnnotationRenderingPort,
        'renderVisiblePages' | 'renderAnnotationEditorLayerForPage'
    >;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    recordPdfjsExecutorCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
    isPdfjsHistoryRouted?: () => boolean;
    routeAnnotationHistoryUndo?: () => boolean;
    routeAnnotationHistoryRedo?: () => boolean;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary[] | undefined;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: (payload: TAnnotationSettingChange) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

type TAnnotationToolState = ReturnType<typeof useAnnotationToolState>;
type TAnnotationFreeTextResize = ReturnType<typeof useFreeTextResize>;

export type TAnnotationEditorController = ReturnType<typeof useAnnotationEditorBridge> & {
    markupSubtype: TAnnotationToolState;
    toolManager: TAnnotationToolState;
    freeTextResize: TAnnotationFreeTextResize;
    setAnnotationTool: TAnnotationToolState['setAnnotationTool'];
    applyAnnotationSettings: TAnnotationToolState['applyAnnotationSettings'];
    updateModeWithRetry: TAnnotationToolState['updateModeWithRetry'];
    getMarkupSubtypeOverrides: TAnnotationToolState['getMarkupSubtypeOverrides'];
    getMarkupSubtypeHints: TAnnotationToolState['getMarkupSubtypeHints'];
    ensureFreeTextEditorCanResize: TAnnotationFreeTextResize['ensureFreeTextEditorCanResize'];
};

export interface IAnnotationOrchestrator {
    identity: ReturnType<typeof useAnnotationIdentity>;
    editor: TAnnotationEditorController;
    commentSync: ReturnType<typeof useAnnotationSync>;
    inlineIndicators: ReturnType<typeof useAnnotationMarkerViewModel>['inlineIndicators'];
    markersByPage: ReturnType<typeof useAnnotationMarkerViewModel>['markersByPage'];
    linksByPage: ComputedRef<Record<number, ILinkAnnotation[]>>;
    highlight: ReturnType<typeof useAnnotationHighlight>;
    crud: ReturnType<typeof useAnnotationCrud>;
}

export const useAnnotationOrchestrator = (
    options: IUseAnnotationOrchestratorOptions,
): IAnnotationOrchestrator => {
    const { t } = useTypedI18n();

    const {
        viewerContainer,
        sourcePdf,
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
        renderingPort,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationState,
        recordPdfjsExecutorCommand,
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
    const linksByPage = computed<Record<number, ILinkAnnotation[]>>(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );

    const freeTextResize = useFreeTextResize({
        getAnnotationUiManager: () => annotationUiManager.value,
        getNumPages: () => numPages.value,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync: () => commentSync.scheduleAnnotationCommentsSync(),
        ...(recordPdfjsExecutorCommand ? {registerHistoryCommand: recordPdfjsExecutorCommand} : {}),
    });

    const toolState = useAnnotationToolState({
        pdfDocument,
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
                return appliedComments;
            },
            setLinkAnnotations: (links) => {
                linkAnnotations.value = links;
            },
            setActiveKey: (key) => {
                const comment = key
                    ? annotationCommentsCache.value.find(candidate => candidate.stableKey === key)
                    : null;
                activeCommentStableKey.value = comment ? annotationIdForSummary(comment) : null;
            },
        }),
        syncInlineCommentIndicators: inlineIndicators.syncInlineCommentIndicators,
        shouldCollectPdfAnnotationNames: () => typeof Blob !== 'undefined' && sourcePdf.value instanceof Blob,
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
        ...(recordPdfjsExecutorCommand ? { recordPdfjsExecutorCommand } : {}),
        ...(isPdfjsHistoryRouted ? { isPdfjsHistoryRouted } : {}),
        ...(routeAnnotationHistoryUndo ? { routeAnnotationHistoryUndo } : {}),
        ...(routeAnnotationHistoryRedo ? { routeAnnotationHistoryRedo } : {}),
        emitAnnotationOpenNote,
    });

    const editor: TAnnotationEditorController = {
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
            if (await renderingPort.renderAnnotationEditorLayerForPage(pageNumber)) {
                return;
            }
            await renderingPort.renderVisiblePages(
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
        renderVisiblePages: renderingPort.renderVisiblePages,
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
