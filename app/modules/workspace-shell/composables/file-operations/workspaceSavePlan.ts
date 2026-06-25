import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentDirtyState } from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';
import {
    computeShouldSerializeFlag,
    shouldPreserveLiveAnnotationSession,
} from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';
import {
    resolveDocumentSaveRoute,
    type TDocumentSaveFlowMode,
} from '@app/modules/workspace-shell/composables/file-operations/documentSaveRoutes';

export type TWorkspaceSavePersistenceRoute =
    | 'working-copy'
    | 'native-working-copy'
    | 'native-mutations-or-serialized'
    | 'serialized-rewrite';

export interface IWorkspaceSavePlanConfig {
    mode: TDocumentSaveFlowMode;
    shouldPreferWorkingCopy: boolean;
    forceSerialize?: boolean;
    forceRewrite?: boolean;
    canPersistNativeWorkingCopy: boolean;
    canAttemptNativeMutationSave: boolean;
}

export interface IWorkspaceSavePlanInput {
    workingCopyPath: TDocumentRef | null;
    expectedOriginalPath: TDocumentRef | null;
    expectedWorkingPath: TDocumentRef | null;
    dirtyState: IDocumentDirtyState;
    hasManagedShapes: boolean;
}

export interface IWorkspaceSavePlan {
    flowMode: TDocumentSaveFlowMode;
    persistenceRoute: TWorkspaceSavePersistenceRoute;
    serialization: {
        shouldSerialize: boolean;
        forcedByDirtyState: boolean;
        requestedByRepairOrOptimization: boolean;
        forceRewrite: boolean;
    };
    pdfjsSourceMaterialization: {
        required: boolean;
        forcePdfjsMaterialize: boolean;
        includeManagedShapesForLiveSource: boolean;
    };
    livePdfjsAnnotationSession: {canPreserve: boolean;};
    rendererFullPdfSerialization: {requiresLargeFileGuard: boolean;};
    staleTargetProtection: {
        expectedOriginalPath: TDocumentRef | null;
        expectedWorkingPath: TDocumentRef | null;
    };
}

export function buildWorkspaceSavePlan(
    config: IWorkspaceSavePlanConfig,
    input: IWorkspaceSavePlanInput,
): IWorkspaceSavePlan {
    const forcedByDirtyState = computeShouldSerializeFlag(input.dirtyState);
    const requestedByRepairOrOptimization = config.forceSerialize === true;
    const shouldSerialize = forcedByDirtyState || requestedByRepairOrOptimization;
    const forcePdfjsMaterialize = input.dirtyState.preservedAnnotationSource;
    const includeManagedShapesForLiveSource = forcePdfjsMaterialize && input.hasManagedShapes;
    const requiredPdfjsSourceMaterialization = forcePdfjsMaterialize
        || input.dirtyState.savedPdfjsAnnotationBaseline;
    const persistenceRoute = resolveWorkspaceSavePersistenceRoute(
        config,
        input,
        {
            forcedByDirtyState,
            includeManagedShapesForLiveSource,
            shouldSerialize,
        },
    );

    return {
        flowMode: config.mode,
        persistenceRoute,
        serialization: {
            shouldSerialize,
            forcedByDirtyState,
            requestedByRepairOrOptimization,
            forceRewrite: config.forceRewrite === true,
        },
        pdfjsSourceMaterialization: {
            required: requiredPdfjsSourceMaterialization,
            forcePdfjsMaterialize,
            includeManagedShapesForLiveSource,
        },
        livePdfjsAnnotationSession: {canPreserve: shouldPreserveLiveAnnotationSession({
            mode: config.mode,
            shouldSerialize,
            dirtyState: input.dirtyState,
        })},
        rendererFullPdfSerialization: {requiresLargeFileGuard: persistenceRoute === 'native-mutations-or-serialized'
                || persistenceRoute === 'serialized-rewrite'},
        staleTargetProtection: {
            expectedOriginalPath: input.expectedOriginalPath,
            expectedWorkingPath: input.expectedWorkingPath,
        },
    };
}

function resolveWorkspaceSavePersistenceRoute(
    config: IWorkspaceSavePlanConfig,
    input: IWorkspaceSavePlanInput,
    derived: {
        forcedByDirtyState: boolean;
        includeManagedShapesForLiveSource: boolean;
        shouldSerialize: boolean;
    },
): TWorkspaceSavePersistenceRoute {
    const route = resolveDocumentSaveRoute({
        mode: config.mode,
        shouldPreferWorkingCopy: config.shouldPreferWorkingCopy,
        canPersistNativeWorkingCopy: config.canPersistNativeWorkingCopy,
        ...(config.forceSerialize !== undefined ? {forceSerialize: config.forceSerialize} : {}),
        ...(config.forceRewrite !== undefined ? {forceRewrite: config.forceRewrite} : {}),
    }, {
        workingCopyPath: input.workingCopyPath,
        expectedOriginalPath: input.expectedOriginalPath,
        expectedWorkingPath: input.expectedWorkingPath,
        shouldSerialize: derived.shouldSerialize,
        shouldSerializeDirtyState: derived.forcedByDirtyState,
    });

    if (route !== 'native-mutations-or-serialized') {
        return route;
    }
    if (
        config.mode !== 'save'
        || !derived.forcedByDirtyState
        || config.forceRewrite === true
        || !config.canAttemptNativeMutationSave
        || input.dirtyState.savedPdfjsAnnotationBaseline
        || derived.includeManagedShapesForLiveSource
    ) {
        return 'serialized-rewrite';
    }

    return 'native-mutations-or-serialized';
}
