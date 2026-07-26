import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IShapeImportSource } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { cloneShape } from '@app/modules/pdf-viewer/engine/shapes/cloneShape';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    buildShapeAnnotation,
    createDrawingShape,
    isDrawableFinishedShape,
    updateDrawingShapeForPoint,
} from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
    focusedShapeId: Ref<string | null>;
    drawingShape: Ref<IShapeAnnotation | null>;
    isShapeToolActive: ComputedRef<boolean>;
    isAnyAnnotationToolActive: ComputedRef<boolean>;
    isSelectionToolActive: ComputedRef<boolean>;
    activeShapeTool: ComputedRef<TDrawableShapeType | null>;
    settings: Ref<IAnnotationSettings>;
    getShapesForPage: (pageIndex: number) => IShapeAnnotation[];
    handleStartDrawing: (pageIndex: number, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueDrawing: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishDrawing: () => void;
    handleSelectShape: (id: string | null) => void;
    handleStartDraggingShape: (shapeId: string, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueDraggingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishDraggingShape: () => void;
    handleStartResizingShape: (shapeId: string, handle: TShapeResizeHandle, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueResizingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishResizingShape: () => void;
    handleShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
}

interface IUseAnnotationShapesOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    notifyShapeCommentsChanged: () => void;
}

/**
 * Renders the canonical shapes `AnnotationStore` owns and forwards drawing and
 * import intents back to it. It holds no shape map, tombstone set or saved
 * baseline of its own: the only state here is transient drawing/selection UI,
 * plus a cache of the last store emission so Vue can depend on it.
 */
export const useAnnotationShapes = ({
    annotationApplication,
    notifyShapeCommentsChanged,
}: IUseAnnotationShapesOptions) => {
    const selectedShapeId = ref<string | null>(null);
    const focusedShapeId = ref<string | null>(null);
    const drawingShape = ref<IShapeAnnotation | null>(null);
    const isDrawing = ref(false);
    const shapeEntities = shallowRef<readonly IShapeEntity[]>([]);
    let drawOrigin: {
        x: number;
        y: number
    } | null = null;

    function projectCanonicalShapes() {
        const entities = annotationApplication.value.store.listShapes({includeDeleted: true});
        shapeEntities.value = entities;
        const liveIds = new Set(entities.filter(entity => !entity.deleted).map(entity => entity.geometry.id));
        if (selectedShapeId.value && !liveIds.has(selectedShapeId.value)) {
            selectedShapeId.value = null;
        }
        if (focusedShapeId.value && !liveIds.has(focusedShapeId.value)) {
            focusedShapeId.value = null;
        }
    }

    let stopProjection: (() => void) | null = null;
    watch(annotationApplication, (application) => {
        stopProjection?.();
        stopProjection = application.store.subscribe(projectCanonicalShapes);
    }, {
        immediate: true,
        flush: 'sync',
    });
    onScopeDispose(() => stopProjection?.());

    function projectShape(entity: IShapeEntity) {
        return {
            ...entity.geometry,
            ...(entity.identity.pdfRef
                ? {
                    source: 'embedded' as const,
                    annotationId: entity.identity.pdfRef,
                }
                : {}),
            ...(entity.identity.pdfName ? {stableKey: entity.identity.pdfName} : {}),
        };
    }

    const liveShapes = computed(() => shapeEntities.value
        .filter(entity => !entity.deleted)
        .map(projectShape));
    const tombstones = computed(() => shapeEntities.value
        .filter(entity => entity.deleted)
        .map(projectShape)
        .filter(shape => shape.source === 'embedded'));

    const shapesByPage = computed(() => {
        const byPage = new Map<number, IShapeAnnotation[]>();
        liveShapes.value.forEach((shape) => {
            const pageShapes = byPage.get(shape.pageIndex);
            if (pageShapes) {
                pageShapes.push(shape);
                return;
            }
            byPage.set(shape.pageIndex, [shape]);
        });
        return byPage;
    });

    const deletedEmbeddedAnnotationIds = computed(() => new Set(
        tombstones.value
            .map(shape => shape.annotationId)
            .filter((annotationId): annotationId is string => Boolean(annotationId)),
    ));
    const deletedEmbeddedShapeStableKeys = computed(() => new Set(
        tombstones.value
            .map(shape => shape.stableKey)
            .filter((stableKey): stableKey is string => Boolean(stableKey)),
    ));
    const hasShapes = computed(() => {
        // Depend on the projection so dirty state re-evaluates with every
        // canonical emission; the store remains the only judge of it.
        void shapeEntities.value;
        return annotationApplication.value.store.hasChangesSinceSavedBaseline('shape');
    });

    function getShapesForPage(pageIndex: number): IShapeAnnotation[] {
        return shapesByPage.value.get(pageIndex) ?? [];
    }

    function getAllShapes(): IShapeAnnotation[] {
        return liveShapes.value.map(shape => structuredClone(shape));
    }

    function getShapeById(id: string): IShapeAnnotation | null {
        return liveShapes.value.find(shape => shape.id === id) ?? null;
    }

    function getDeletedEmbeddedAnnotationIds() {
        return [...deletedEmbeddedAnnotationIds.value];
    }

    function getDeletedEmbeddedShapeStableKeys() {
        return [...deletedEmbeddedShapeStableKeys.value];
    }

    function importEmbeddedShapes(imported: IShapeAnnotation[], source: IShapeImportSource) {
        const plan = annotationApplication.value.importEmbeddedShapes(imported, source);
        BrowserLogger.debug('pdf-shapes', 'Applied embedded shape import', () => ({
            importedShapeCount: imported.length,
            mode: plan.mode,
            reason: plan.reason,
            shapeCount: liveShapes.value.length,
            deletedAnnotationIds: getDeletedEmbeddedAnnotationIds(),
            deletedStableKeys: getDeletedEmbeddedShapeStableKeys(),
        }));
        notifyShapeCommentsChanged();
        return plan;
    }

    function resetShapeImportBaseline() {
        annotationApplication.value.store.resetShapeImportBaseline();
        notifyShapeCommentsChanged();
    }

    function isShapeImportBaselineReady() {
        return annotationApplication.value.store.hasShapeImportBaseline;
    }

    function preservesShapeImportBaseline(source: IShapeImportSource) {
        return annotationApplication.value.store.preservesShapeImportBaseline(source);
    }

    function clearPendingShapeImportAdoption() {
        annotationApplication.value.store.clearPendingShapeImportAdoption();
    }

    /**
     * Captures the shape save frontier bound to the store that owns it, so a
     * rollback after a failed save can never reach a store that replaced this
     * one — a later document's structurally identical frontier included.
     */
    function beginShapeSave() {
        const store = annotationApplication.value.store;
        const frontier = store.beginSave();
        return {
            primePersistedShapes(imported: IShapeAnnotation[]) {
                const applied = annotationApplication.value.store === store
                    && annotationApplication.value.primePersistedShapes(imported, frontier);
                if (applied) {
                    notifyShapeCommentsChanged();
                }
                return applied;
            },
            rollback() {
                const rolledBack = store.rollbackToSaveFrontier(frontier);
                if (rolledBack && annotationApplication.value.store === store) {
                    notifyShapeCommentsChanged();
                }
                return rolledBack;
            },
        };
    }

    function markSavedShapeState() {
        annotationApplication.value.store.markShapesSaved();
    }

    function clearShapes() {
        annotationApplication.value.store.resetShapeImportBaseline();
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        resetDrawingState();
    }

    function selectShape(id: string | null) {
        selectedShapeId.value = id;
        focusedShapeId.value = null;
    }

    function focusShape(id: string | null) {
        focusedShapeId.value = id && getShapeById(id) ? id : null;
        selectedShapeId.value = null;
    }

    function resetDrawingState() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    function startDrawing(
        pageIndex: number,
        tool: TDrawableShapeType,
        x: number,
        y: number,
        settings: IAnnotationSettings,
    ) {
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        drawOrigin = {
            x,
            y,
        };
        drawingShape.value = createDrawingShape(pageIndex, tool, x, y, settings);
        isDrawing.value = true;
    }

    function continueDrawing(x: number, y: number) {
        if (!drawingShape.value || !isDrawing.value || !drawOrigin) {
            return;
        }

        drawingShape.value = updateDrawingShapeForPoint(drawingShape.value, drawOrigin, x, y);
    }

    /** Returns the finished draft; the shape enters the store through its creator. */
    function finishDrawing() {
        if (!drawingShape.value || !isDrawing.value) {
            return null;
        }

        const shape = cloneShape({
            ...drawingShape.value,
            modifiedAt: Date.now(),
        });
        resetDrawingState();
        return isDrawableFinishedShape(shape) ? shape : null;
    }

    return {
        selectedShapeId,
        focusedShapeId,
        drawingShape,
        hasShapes,
        getShapesForPage,
        getAllShapes,
        getShapeById,
        getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
        deletedEmbeddedShapeStableKeys,
        selectShape,
        focusShape,
        clearShapes,
        importEmbeddedShapes,
        resetShapeImportBaseline,
        isShapeImportBaselineReady,
        preservesShapeImportBaseline,
        clearPendingShapeImportAdoption,
        beginShapeSave,
        markSavedShapeState,
        buildShapeAnnotation,
        startDrawing,
        continueDrawing,
        finishDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
