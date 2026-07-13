import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    createPostSaveReloadHandle,
    type IPostSaveReloadHandle,
} from '@app/modules/workspace-shell/composables/file-operations/postSaveReload';
import type { IDocumentDirtyState } from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';
import {
    selectSerializationMechanism,
    type ISerializationMechanismSelection,
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
    dirtyState: IDocumentDirtyState;
    savePlan: ISerializationMechanismSelection;
    saveStateSnapshot: ISaveStateSnapshot;
    reloadWaiter: IPostSaveReloadHandle;
    shapeStateDirty: boolean;
}

export interface IFileOperationsSaveContextPorts {
    state: Pick<IFileOperationsSaveStatePorts, 'documentIdentity' | 'annotations' | 'metadata'>;
    pdf: Pick<IFileOperationsSavePdfPorts, 'source'>;
    annotationEdits: Pick<
        IWorkspaceSaveEmbeddedAnnotationEditsPort,
        | 'annotationNoteWindowsCount'
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

    function collectDocumentDirtyState(shapeStateDirty: boolean): IDocumentDirtyState {
        return {
            annotationChanges: state.annotations.hasAnnotationChanges(),
            annotationDirty: state.annotations.annotationDirty.value,
            bookmarks: state.metadata.bookmarksDirty.value,
            livePdfJsAnnotations: state.annotations.hasLivePdfJsAnnotationChanges?.() ?? false,
            pageLabels: state.metadata.pageLabelsDirty.value,
            pendingDeletes: state.annotations.hasPendingAnnotationDeletes?.() ?? false,
            pendingTexts: false,
            preservedAnnotationSource: state.annotations.hasPreservedAnnotationSourceChanges?.() ?? false,
            savedPdfjsAnnotationBaseline: state.annotations.hasSavedPdfJsAnnotationBaselineChanges?.() ?? false,
            shapes: shapeStateDirty,
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
        const shapeStateDirty = viewer.shapes.hasShapeChanges?.() ?? false;
        const dirtyState = collectDocumentDirtyState(shapeStateDirty);
        const savePlan = selectSerializationMechanism({
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
            expectedDocumentRevisionToken: state.documentIdentity.documentRevisionToken.value,
            dirtyState,
            hasManagedShapes: viewer.shapes.hasManagedShapes?.() ?? false,
        });
        const context: IFileOperationsSaveContext = {
            dirtyState,
            savePlan,
            saveStateSnapshot,
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

        BrowserLogger.diagnostic('workspace', 'Starting handleSave', () => ({
            hasWorkingCopyPath: Boolean(state.documentIdentity.workingCopyPath.value),
            annotationDirty: state.annotations.annotationDirty.value,
            pageLabelsDirty: state.metadata.pageLabelsDirty.value,
            bookmarksDirty: state.metadata.bookmarksDirty.value,
            hasAnnotationChanges: context.dirtyState.annotationChanges,
            hasShapeChanges: context.shapeStateDirty,
            hasLivePdfJsAnnotationChanges: context.dirtyState.livePdfJsAnnotations,
            canAttemptNativeMutationSave: config.canAttemptNativeMutationSave,
            forceSerialize: config.forceSerialize === true,
            forceRewrite: config.forceRewrite === true,
            savePlanRoute: context.savePlan.persistenceRoute,
            preserveLivePdfjsAnnotationSession: context.savePlan.livePdfjsAnnotationSession.canPreserve,
            savedPdfjsAnnotationBaselineDirty: context.dirtyState.savedPdfjsAnnotationBaseline,
            preservedAnnotationSourceDirty: context.dirtyState.preservedAnnotationSource,
            hasManagedShapes: viewer.shapes.hasManagedShapes?.() ?? false,
            includeManagedShapesForLiveSource: context.savePlan.pdfjsSourceMaterialization.includeManagedShapesForLiveSource,
            annotationNoteWindowsCount: annotationEdits.annotationNoteWindowsCount.value,
        }));
    }

    return {prepareSaveContext};
}
