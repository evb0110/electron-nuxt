import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IHighlightIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
}

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
    pendingCommentEditorKeys: Set<string>;
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
    ensureAnnotationEditorLayerReady?: (pageNumber: number) => Promise<void>;
    deferCreatedEditorUndoToStorage?: boolean;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export interface IEditorSnapshot {
    editorsBeforeRefs: Set<IPdfjsEditor>;
    editorsBeforeIds: Set<string>;
}

export interface IHighlightCommentContext {
    targetEditor: IPdfjsEditor | null;
    pageIndex: number;
    selectionPreviewText: string;
    editorSnapshot: IEditorSnapshot;
    getEditorsForPage: (pageIndex: number) => IPdfjsEditor[];
    identity: IHighlightIdentity;
    markupSubtypeOverride: TMarkupSubtype | null;
    markupSubtype: IHighlightMarkupSubtype;
    commentSync: IHighlightSync;
    modeRestoredPromise: Promise<void>;
    registerCreatedEditorUndo: (editor: IPdfjsEditor | null) => boolean;
    applySubtypeOverrideToEditor: (editor: IPdfjsEditor | null) => boolean;
    clearEditorSelectionVisuals: (editor: IPdfjsEditor | null) => void;
}
