import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TDocumentRef } from '@contracts/documentRef';
import { mergeAnnotationCommentSaveSnapshot } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    createPostSaveReloadHandle,
    type IPostSaveReloadHandle,
} from '@app/modules/workspace-shell/composables/file-operations/postSaveReload';
import type { IDocumentDirtyState } from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';
import {
    buildWorkspaceSavePlan,
    type IWorkspaceSavePlan,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';
import type { ISaveStateSnapshot } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveCompletion';
import type {
    IFileOperationsSavePdfPorts,
    IFileOperationsSaveStatePorts,
    IFileOperationsSaveViewerPorts,
    IWorkspaceSaveEmbeddedAnnotationEditsPort,
    IWorkspaceSaveLifecyclePort,
} from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';

type TSaveFlowMode = 'save' | 'save_as';

export interface IFileOperationsSaveContextRequest {
    mode: TSaveFlowMode;
    persistOpenNotesAbortMessage: string;
    shouldPreferWorkingCopy: boolean;
    canPersistNativeWorkingCopy: boolean;
    canAttemptNativeMutationSave: boolean;
    forceSerialize?: boolean | undefined;
    forceRewrite?: boolean | undefined;
}

export interface IFileOperationsSaveContext {
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    dirtyState: IDocumentDirtyState;
    savePlan: IWorkspaceSavePlan;
    saveStateSnapshot: ISaveStateSnapshot;
    hasPendingDeletes: boolean;
    hasPendingTexts: boolean;
    pendingDeletes: IAnnotationCommentSummary[] | null;
    pendingTexts: Map<string, string> | null;
    pendingChangesSource: 'viewer-service' | 'workspace-compat';
    reloadWaiter: IPostSaveReloadHandle;
    shapeStateDirty: boolean;
}

export interface IFileOperationsSaveContextPorts {
    state: Pick<IFileOperationsSaveStatePorts, 'documentIdentity' | 'annotations' | 'metadata'>;
    pdf: Pick<IFileOperationsSavePdfPorts, 'source'>;
    annotationEdits: Pick<
        IWorkspaceSaveEmbeddedAnnotationEditsPort,
        | 'annotationNoteWindowsCount'
        | 'consumePendingEmbeddedAnnotationDeletes'
        | 'consumePendingEmbeddedTextUpdates'
        | 'persistAllAnnotationNotes'
    >;
    viewer: Pick<IFileOperationsSaveViewerPorts, 'markup' | 'shapes'>;
    lifecycle: Pick<IWorkspaceSaveLifecyclePort, 'preparePostSaveReload'>;
}

export interface IFileOperationsSaveContextServices {
    captureSaveStateSnapshot: () => ISaveStateSnapshot;
    timedSavePhase: <T>(
        phase: string,
        operation: () => Promise<T>,
        describeResult?: (result: T) => Record<string, unknown>,
    ) => Promise<T>;
}

interface IPendingEmbeddedAnnotationChanges {
    pendingTexts: Map<string, string> | null;
    pendingDeletes: IAnnotationCommentSummary[] | null;
    hasPendingTexts: boolean;
    hasPendingDeletes: boolean;
    source: 'viewer-service' | 'workspace-compat';
}

export function createFileOperationsSaveContext(
    ports: IFileOperationsSaveContextPorts,
    services: IFileOperationsSaveContextServices,
) {
    const {
        state,
        annotationEdits,
        viewer,
        lifecycle,
    } = ports;

    function getAnnotationCommentsForSave() {
        return mergeAnnotationCommentSaveSnapshot(
            viewer.markup.getAnnotationCommentsSnapshot?.(),
            state.annotations.annotationComments.value,
        );
    }

    async function persistOpenAnnotationNotes(abortMessage: string) {
        if (annotationEdits.annotationNoteWindowsCount.value <= 0) {
            return true;
        }

        const savedNotes = await annotationEdits.persistAllAnnotationNotes(true);
        if (!savedNotes) {
            BrowserLogger.warn('workspace', abortMessage);
            return false;
        }

        return true;
    }

    function consumePendingEmbeddedAnnotationChanges(): IPendingEmbeddedAnnotationChanges {
        const viewerSnapshot = viewer.markup.getPendingEmbeddedMutationSnapshot?.();
        if (viewerSnapshot) {
            const pendingTexts = viewerSnapshot.pendingEmbeddedTextUpdates.size > 0
                ? viewerSnapshot.pendingEmbeddedTextUpdates
                : null;
            const pendingDeletes = viewerSnapshot.pendingEmbeddedAnnotationDeletes.length > 0
                ? viewerSnapshot.pendingEmbeddedAnnotationDeletes
                : null;
            return {
                pendingTexts,
                pendingDeletes,
                hasPendingTexts: Boolean(pendingTexts && pendingTexts.size > 0),
                hasPendingDeletes: Boolean(pendingDeletes && pendingDeletes.length > 0),
                source: 'viewer-service',
            };
        }

        const pendingTexts = annotationEdits.consumePendingEmbeddedTextUpdates();
        const pendingDeletes = annotationEdits.consumePendingEmbeddedAnnotationDeletes();
        return {
            pendingTexts,
            pendingDeletes,
            hasPendingTexts: Boolean(pendingTexts && pendingTexts.size > 0),
            hasPendingDeletes: Boolean(pendingDeletes && pendingDeletes.length > 0),
            source: 'workspace-compat',
        };
    }

    function collectDocumentDirtyState(options: {
        hasPendingDeletes: boolean;
        hasPendingTexts: boolean;
        shapeStateDirty: boolean;
    }): IDocumentDirtyState {
        return {
            annotationChanges: state.annotations.hasAnnotationChanges(),
            annotationDirty: state.annotations.annotationDirty.value,
            bookmarks: state.metadata.bookmarksDirty.value,
            livePdfJsAnnotations: state.annotations.hasLivePdfJsAnnotationChanges?.() ?? false,
            pageLabels: state.metadata.pageLabelsDirty.value,
            pendingDeletes: options.hasPendingDeletes,
            pendingTexts: options.hasPendingTexts,
            preservedAnnotationSource: state.annotations.hasPreservedAnnotationSourceChanges?.() ?? false,
            savedPdfjsAnnotationBaseline: state.annotations.hasSavedPdfJsAnnotationBaselineChanges?.() ?? false,
            shapes: options.shapeStateDirty,
        };
    }

    async function prepareSaveContext(
        config: IFileOperationsSaveContextRequest,
        expectedWorkingPath: TDocumentRef | null,
        expectedOriginalPath: TDocumentRef | null,
    ): Promise<IFileOperationsSaveContext | null> {
        if (!await persistOpenAnnotationNotes(config.persistOpenNotesAbortMessage)) {
            return null;
        }
        const saveStateSnapshot = services.captureSaveStateSnapshot();
        const pendingChanges = consumePendingEmbeddedAnnotationChanges();
        const shapeStateDirty = viewer.shapes.hasShapeChanges?.() ?? false;
        const dirtyState = collectDocumentDirtyState({
            hasPendingTexts: pendingChanges.hasPendingTexts,
            hasPendingDeletes: pendingChanges.hasPendingDeletes,
            shapeStateDirty,
        });
        const savePlan = buildWorkspaceSavePlan({
            mode: config.mode,
            shouldPreferWorkingCopy: config.shouldPreferWorkingCopy,
            canPersistNativeWorkingCopy: config.canPersistNativeWorkingCopy,
            canAttemptNativeMutationSave: config.canAttemptNativeMutationSave,
            ...(config.forceSerialize !== undefined ? {forceSerialize: config.forceSerialize} : {}),
            ...(config.forceRewrite !== undefined ? {forceRewrite: config.forceRewrite} : {}),
        }, {
            workingCopyPath: state.documentIdentity.workingCopyPath.value,
            expectedOriginalPath,
            expectedWorkingPath,
            dirtyState,
            hasManagedShapes: viewer.shapes.hasManagedShapes?.() ?? false,
        });
        const context: IFileOperationsSaveContext = {
            annotationCommentsSnapshot: getAnnotationCommentsForSave(),
            dirtyState,
            savePlan,
            saveStateSnapshot,
            hasPendingDeletes: pendingChanges.hasPendingDeletes,
            hasPendingTexts: pendingChanges.hasPendingTexts,
            pendingDeletes: pendingChanges.pendingDeletes,
            pendingTexts: pendingChanges.pendingTexts,
            pendingChangesSource: pendingChanges.source,
            reloadWaiter: createPostSaveReloadHandle(
                lifecycle.preparePostSaveReload,
                savePlan.livePdfjsAnnotationSession.canPreserve,
            ),
            shapeStateDirty,
        };
        logSaveFlowStart(config, context);
        return context;
    }

    function logSaveFlowStart(
        config: IFileOperationsSaveContextRequest,
        context: IFileOperationsSaveContext,
    ) {
        if (config.mode !== 'save') {
            return;
        }

        BrowserLogger.debug('workspace', 'Starting handleSave', () => ({
            hasWorkingCopyPath: Boolean(state.documentIdentity.workingCopyPath.value),
            annotationDirty: state.annotations.annotationDirty.value,
            pageLabelsDirty: state.metadata.pageLabelsDirty.value,
            bookmarksDirty: state.metadata.bookmarksDirty.value,
            hasAnnotationChanges: context.dirtyState.annotationChanges,
            hasShapeChanges: context.shapeStateDirty,
            hasPendingTexts: context.hasPendingTexts,
            hasPendingDeletes: context.hasPendingDeletes,
            hasLivePdfJsAnnotationChanges: context.dirtyState.livePdfJsAnnotations,
            forceSerialize: config.forceSerialize === true,
            forceRewrite: config.forceRewrite === true,
            savePlanRoute: context.savePlan.persistenceRoute,
            preserveLivePdfjsAnnotationSession: context.savePlan.livePdfjsAnnotationSession.canPreserve,
            savedPdfjsAnnotationBaselineDirty: context.dirtyState.savedPdfjsAnnotationBaseline,
            preservedAnnotationSourceDirty: context.dirtyState.preservedAnnotationSource,
            includeManagedShapesForLiveSource: context.savePlan.pdfjsSourceMaterialization.includeManagedShapesForLiveSource,
            annotationNoteWindowsCount: annotationEdits.annotationNoteWindowsCount.value,
        }));
    }

    return {
        getAnnotationCommentsForSave,
        prepareSaveContext,
    };
}
