import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';

export type TWorkspaceSaveRequest =
    | {kind: 'save'}
    | {
        kind: 'save-as';
        optimizeLossless: boolean
    }
    | {kind: 'repair'}
    | {kind: 'optimize'}
    | {
        kind: 'optimize-copy';
        options: IPdfOptimizeOptions;
        requestId?: string;
    };

export interface IWorkspaceSaveTarget {
    expectedOriginalPath: TDocumentRef | null;
    expectedWorkingPath: TDocumentRef | null;
    expectedRevisionToken: TDocumentRevisionToken | null;
}

export interface IWorkspaceSaveBaseline {
    annotations: unknown;
    pageLabels: unknown;
    bookmarks: unknown;
    shapes: boolean;
}

export interface IWorkspaceSaveDirtyState {
    annotationDirty: boolean;
    annotationChanges: boolean;
    bookmarks: boolean;
    livePdfJsAnnotations: boolean;
    pageLabels: boolean;
    pendingDeletes: boolean;
    preservedAnnotationSource: boolean;
    savedPdfjsAnnotationBaseline: boolean;
    shapes: boolean;
}

export interface IWorkspaceSerializedSaveBody {
    source: 'live-pdfjs' | 'working-copy';
    forceRewrite: boolean;
    includeManagedShapes: boolean;
    preserveLoadedSource: boolean;
    requiresLargeFileGuard: boolean;
}

interface IWorkspaceSavePlanCommon {
    request: TWorkspaceSaveRequest;
    target: IWorkspaceSaveTarget;
    baseline: IWorkspaceSaveBaseline;
    dirtyState: IWorkspaceSaveDirtyState;
}

export type TWorkspaceSavePlan =
    | IWorkspaceSavePlanCommon & {
        kind: 'serialized';
        destination: 'original' | 'save-as';
        body: IWorkspaceSerializedSaveBody;
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'native-working-copy';
        request: Extract<TWorkspaceSaveRequest, {kind: 'repair' | 'optimize'}>;
        operation: 'repair' | 'optimize';
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'native-mutation';
        request: Extract<TWorkspaceSaveRequest, {kind: 'save'}>;
        serializedFallback: IWorkspaceSerializedSaveBody;
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'optimization';
        request: Extract<TWorkspaceSaveRequest, {kind: 'optimize-copy'}>;
    };

export function createWorkspaceSavePlan(input: {
    request: TWorkspaceSaveRequest;
    target: IWorkspaceSaveTarget;
    baseline: IWorkspaceSaveBaseline;
    dirtyState: IWorkspaceSaveDirtyState;
    hasManagedShapes: boolean;
    canPersistNativeWorkingCopy: boolean;
    canPersistNativeMutations: boolean;
}): TWorkspaceSavePlan {
    const {
        request,
        target,
        baseline,
        dirtyState,
    } = input;
    const common = {
        request,
        target,
        baseline,
        dirtyState,
    };

    if (request.kind === 'optimize-copy') {
        return {
            ...common,
            kind: 'optimization',
            request,
        };
    }

    const forcedByDirtyState = Object.values(dirtyState).some(Boolean);
    const forceRewrite = request.kind === 'repair' || request.kind === 'optimize';
    const shouldSerialize = forcedByDirtyState || forceRewrite;
    const includeManagedShapes = dirtyState.preservedAnnotationSource && input.hasManagedShapes;
    const preserveLoadedSource = request.kind === 'save'
        && shouldSerialize
        && !dirtyState.pendingDeletes
        && !dirtyState.pageLabels
        && !dirtyState.bookmarks
        && (
            dirtyState.shapes
            || dirtyState.livePdfJsAnnotations
            || dirtyState.preservedAnnotationSource
            || dirtyState.annotationChanges
        );
    const serializedBody: IWorkspaceSerializedSaveBody = {
        source: shouldSerialize ? 'live-pdfjs' : 'working-copy',
        forceRewrite,
        includeManagedShapes,
        preserveLoadedSource,
        requiresLargeFileGuard: shouldSerialize,
    };

    if (
        (request.kind === 'repair' || request.kind === 'optimize')
        && !forcedByDirtyState
        && Boolean(target.expectedOriginalPath)
        && Boolean(target.expectedWorkingPath)
        && input.canPersistNativeWorkingCopy
    ) {
        return {
            ...common,
            kind: 'native-working-copy',
            request,
            operation: request.kind,
        };
    }

    if (
        request.kind === 'save'
        && forcedByDirtyState
        && input.canPersistNativeMutations
        && !dirtyState.savedPdfjsAnnotationBaseline
        && !includeManagedShapes
    ) {
        return {
            ...common,
            kind: 'native-mutation',
            request,
            serializedFallback: serializedBody,
        };
    }

    return {
        ...common,
        kind: 'serialized',
        destination: request.kind === 'save-as' ? 'save-as' : 'original',
        body: serializedBody,
    };
}
