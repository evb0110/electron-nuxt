import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { isShapeTool } from '@app/composables/pdf/annotations/annotationRules';

interface IPdfViewerForAnnotationTools {
    cancelCommentPlacement: () => void;
    clearSelectedShape: () => void;
    selectedShapeId: string | null;
    getSelectedShape: () => (IShapeAnnotation & { pdfSubtype?: string | null | undefined }) | null;
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
}

interface IPageAnnotationToolsDeps {
    pdfViewerRef: Ref<IPdfViewerForAnnotationTools | null>;
    dragMode: Ref<boolean>;
    clearAnnotationChanges: () => void;
    closeAnnotationContextMenu: () => void;
    hasAnnotationChanges: () => boolean;
}

export const usePageAnnotationTools = (deps: IPageAnnotationToolsDeps) => {
    const {
        pdfViewerRef,
        dragMode,
        clearAnnotationChanges,
        closeAnnotationContextMenu,
        hasAnnotationChanges,
    } = deps;

    const annotationTool = ref<TAnnotationTool>('none');
    const annotationKeepActive = ref(true);
    const annotationPlacingPageNote = ref(false);
    const annotationSettings = ref<IAnnotationSettings>({ ...DEFAULT_ANNOTATION_SETTINGS });
    const annotationComments = ref<IAnnotationCommentSummary[]>([]);
    const annotationCommentsStatus = ref<TAnnotationCommentsStatus>('loading');
    const annotationActiveCommentStableKey = ref<string | null>(null);
    const annotationEditorState = ref<IAnnotationEditorState>({
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    });

    const annotationRevision = ref(0);
    const annotationSavedRevision = ref(0);
    const annotationDirty = computed(() => annotationRevision.value !== annotationSavedRevision.value);

    type TShapeSettingUpdateResolver = (value: IAnnotationSettings[keyof IAnnotationSettings]) => Record<string, unknown>;

    const inkShapeSettingUpdates: Partial<Record<keyof IAnnotationSettings, TShapeSettingUpdateResolver>> = {
        inkColor: value => ({ color: String(value) }),
        inkThickness: value => ({ strokeWidth: Number(value) }),
        inkOpacity: value => ({ opacity: Number(value) }),
    };

    const shapeSettingUpdates: Partial<Record<keyof IAnnotationSettings, TShapeSettingUpdateResolver>> = {
        shapeColor: value => ({ color: String(value) }),
        shapeStrokeWidth: value => ({ strokeWidth: Number(value) }),
        shapeOpacity: value => ({ opacity: Number(value) }),
        shapeFillColor: (value) => {
            const fill = String(value);
            return { fillColor: fill === 'transparent' ? undefined : fill };
        },
    };

    function getSelectedShapeSettingUpdate(
        key: keyof IAnnotationSettings,
        value: IAnnotationSettings[keyof IAnnotationSettings],
        isInkShape: boolean,
    ): Record<string, unknown> | null {
        const resolver = (isInkShape ? inkShapeSettingUpdates[key] : null) ?? shapeSettingUpdates[key];
        return resolver?.(value) ?? null;
    }

    function handleAnnotationToolChange(tool: TAnnotationTool) {
        annotationTool.value = tool;
        dragMode.value = false;
        pdfViewerRef.value?.cancelCommentPlacement();
        if (tool !== 'select') {
            pdfViewerRef.value?.clearSelectedShape();
        }
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolAutoReset() {
        if (annotationKeepActive.value) {
            return;
        }
        const previousTool = annotationTool.value;
        if (isShapeTool(previousTool)) {
            annotationTool.value = 'select';
            annotationPlacingPageNote.value = false;
            closeAnnotationContextMenu();
            return;
        }
        annotationTool.value = 'none';
        pdfViewerRef.value?.clearSelectedShape();
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolCancel() {
        annotationTool.value = 'none';
        pdfViewerRef.value?.clearSelectedShape();
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationSettingChange(payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }) {
        annotationSettings.value = {
            ...annotationSettings.value,
            [payload.key]: payload.value,
        };

        const selectedShapeId = pdfViewerRef.value?.selectedShapeId;
        if (!selectedShapeId) {
            return;
        }

        const selectedShape = pdfViewerRef.value?.getSelectedShape();
        const updates = getSelectedShapeSettingUpdate(
            payload.key,
            payload.value,
            selectedShape?.pdfSubtype === 'Ink',
        );
        if (updates) {
            pdfViewerRef.value?.updateShape(selectedShapeId, updates);
        }
    }

    function handleAnnotationState(state: IAnnotationEditorState) {
        const hadUndo = annotationEditorState.value.hasSomethingToUndo;
        annotationEditorState.value = {
            ...annotationEditorState.value,
            ...state,
        };
        if (!hadUndo && annotationEditorState.value.hasSomethingToUndo) {
            markAnnotationDirty();
        }
        if (hadUndo && !annotationEditorState.value.hasSomethingToUndo) {
            clearAnnotationChanges();
            if (!hasAnnotationChanges()) {
                syncAnnotationClean();
            }
        }
    }

    function handleAnnotationModified(payload: IAnnotationModifiedPayload = {}) {
        if (payload.forceDirty) {
            markAnnotationDirty();
            return;
        }
        if (
            !annotationEditorState.value.hasSomethingToUndo
            && !hasAnnotationChanges()
        ) {
            syncAnnotationClean();
            return;
        }
        if (!hasAnnotationChanges()) {
            syncAnnotationClean();
            return;
        }
        markAnnotationDirty();
    }

    function markAnnotationDirty() {
        annotationRevision.value += 1;
    }

    function syncAnnotationClean() {
        annotationRevision.value = annotationSavedRevision.value;
    }

    function markAnnotationSaved() {
        annotationSavedRevision.value = annotationRevision.value;
    }

    function resetAnnotationTracking() {
        annotationRevision.value = 0;
        annotationSavedRevision.value = 0;
    }

    function markAnnotationCommentsLoading() {
        if (annotationCommentsStatus.value === 'ready' && annotationComments.value.length === 0) {
            return;
        }
        annotationCommentsStatus.value = 'loading';
    }

    function applyAnnotationComments(comments: IAnnotationCommentSummary[]) {
        annotationComments.value = comments;
        annotationCommentsStatus.value = 'ready';
    }

    function clearAnnotationComments() {
        annotationComments.value = [];
        annotationCommentsStatus.value = 'loading';
    }

    return {
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationRevision,
        annotationSavedRevision,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        clearAnnotationComments,
    };
};
