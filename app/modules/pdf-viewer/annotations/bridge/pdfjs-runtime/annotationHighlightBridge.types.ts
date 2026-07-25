import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationMarkerRect,
    IAnnotationCommentSummary,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IHighlightIdentity {getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;}

export interface IHighlightMarkupSubtype {
    toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    isSelectionMarkupTool: (tool: TAnnotationTool) => boolean;
    setEditorMarkupSubtypeOverride: (
        e: IPdfjsEditor,
        pi: number,
        s: TMarkupSubtype,
        opts?: { preferEditorColor?: boolean },
    ) => void;
    resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
    syncMarkupSubtypePresentationForEditors: () => void;
}

export interface IHighlightSync {
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
    toEditorSummary: (editor: IPdfjsEditor, pageIndex: number, text: string) => IAnnotationCommentSummary;
}

export interface IHighlightToolManager {
    updateModeWithRetry: (
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber?: number,
    ) => Promise<unknown>;
    maybeAutoResetAnnotationTool: () => void;
}

export interface IHighlightAnnotationCommands {
    applySelectionMarkup: (input: {
        pageIndex: number;
        subtype: TMarkupSubtype;
        geometry: readonly IAnnotationMarkerRect[];
        overlapCandidates: ReadonlyArray<{
            summary: IAnnotationCommentSummary;
            observedGeometry: readonly IAnnotationMarkerRect[];
        }>;
    }) => {
        annotationId: string;
        comment: IAnnotationCommentSummary;
        replacements: ReadonlyArray<{
            annotationId: string;
            sourceStableKey: string;
            geometry: readonly IAnnotationMarkerRect[];
            deleted: boolean;
        }>;
    };
    createStickyNote: (input: {
        pageIndex: number;
        anchor: IAnnotationMarkerRect;
    }) => {
        annotationId: string;
        comment: IAnnotationCommentSummary;
    };
    bindEditorIdentity: (
        annotationId: string,
        summary: IAnnotationCommentSummary,
    ) => void;
}

export interface IUseAnnotationHighlightOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: {value: number};
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    getIdentity: () => IHighlightIdentity;
    getMarkupSubtype: () => IHighlightMarkupSubtype;
    getSync: () => IHighlightSync;
    getToolManager: () => IHighlightToolManager;
    getAnnotationCommands: () => IHighlightAnnotationCommands;
    ensureAnnotationEditorLayerReady?: (pageNumber: number) => Promise<void>;
    deferCreatedEditorUndoToStorage?: boolean;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export interface IEditorSnapshot {editorsBeforeIds: Set<string>;}
