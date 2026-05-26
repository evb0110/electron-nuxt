import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type {
    PDFDocumentProxy,
    TFitMode,
    TZoomMode,
} from '@app/types/pdf';
import type { TPdfViewerEmit } from './pdfViewerComponent.types';

export interface IPdfViewerEventAdapter {
    updateZoom(value: number): void;
    updateZoomMode(mode: TZoomMode): void;
    updateFitMode(mode: TFitMode): void;
    updateEffectiveZoom(value: number): void;
    updateCurrentPage(page: number): void;
    updateTotalPages(total: number): void;
    updateLoading(loading: boolean): void;
    updateDocument(document: PDFDocumentProxy | null): void;
    loading(loading: boolean): void;
    annotationState(state: IAnnotationEditorState): void;
    annotationModified(payload?: IAnnotationModifiedPayload): void;
    annotationComments(comments: IAnnotationCommentSummary[]): void;
    annotationOpenNote(comment: IAnnotationCommentSummary): void;
    annotationContextMenu(payload: IAnnotationContextMenuPayload): void;
    annotationToolAutoReset(): void;
    annotationSetting(payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
    annotationCommentClick(comment: IAnnotationCommentSummary): void;
    annotationToolCancel(): void;
    annotationNotePlacementChange(active: boolean): void;
    shapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
    imagePlacementFinalize(payload: IPdfPlacedImageFinalizePayload): void;
    initialVisualPending(): void;
    initialVisualReady(payload: {pageNumber: number;}): void;
}

export function createPdfViewerEventAdapter(emit: TPdfViewerEmit): IPdfViewerEventAdapter {
    return {
        updateZoom: value => emit('update:zoom', value),
        updateZoomMode: mode => emit('update:zoomMode', mode),
        updateFitMode: mode => emit('update:fitMode', mode),
        updateEffectiveZoom: value => emit('update:effectiveZoom', value),
        updateCurrentPage: page => emit('update:currentPage', page),
        updateTotalPages: total => emit('update:totalPages', total),
        updateLoading: loading => emit('update:loading', loading),
        updateDocument: document => emit('update:document', document),
        loading: loading => emit('loading', loading),
        annotationState: state => emit('annotation-state', state),
        annotationModified: payload => emit('annotation-modified', payload),
        annotationComments: comments => emit('annotation-comments', comments),
        annotationOpenNote: comment => emit('annotation-open-note', comment),
        annotationContextMenu: payload => emit('annotation-context-menu', payload),
        annotationToolAutoReset: () => emit('annotation-tool-auto-reset'),
        annotationSetting: payload => emit('annotation-setting', payload),
        annotationCommentClick: comment => emit('annotation-comment-click', comment),
        annotationToolCancel: () => emit('annotation-tool-cancel'),
        annotationNotePlacementChange: active => emit('annotation-note-placement-change', active),
        shapeContextMenu: payload => emit('shape-context-menu', payload),
        imagePlacementFinalize: payload => emit('image-placement-finalize', payload),
        initialVisualPending: () => emit('initial-visual-pending'),
        initialVisualReady: payload => emit('initial-visual-ready', payload),
    };
}
