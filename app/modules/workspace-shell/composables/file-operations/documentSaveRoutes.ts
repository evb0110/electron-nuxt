import type { TDocumentRef } from '@contracts/documentRef';

export type TDocumentSaveFlowMode = 'save' | 'save_as';

export type TDocumentSaveRoute =
    | 'working-copy'
    | 'native-working-copy'
    | 'native-mutations-or-serialized';

export interface IDocumentSaveRouteConfig {
    mode: TDocumentSaveFlowMode;
    shouldPreferWorkingCopy: boolean;
    forceSerialize?: boolean;
    forceRewrite?: boolean;
    canPersistNativeWorkingCopy: boolean;
}

export interface IDocumentSaveRouteContext {
    workingCopyPath: TDocumentRef | null;
    expectedOriginalPath: TDocumentRef | null;
    expectedWorkingPath: TDocumentRef | null;
    shouldSerialize: boolean;
    shouldSerializeDirtyState: boolean;
}

export function resolveDocumentSaveRoute(
    config: IDocumentSaveRouteConfig,
    context: IDocumentSaveRouteContext,
): TDocumentSaveRoute {
    if (config.shouldPreferWorkingCopy && context.workingCopyPath && !context.shouldSerialize) {
        return 'working-copy';
    }
    if (config.mode === 'save_as' && !context.shouldSerialize) {
        return 'working-copy';
    }
    if (
        config.forceSerialize === true
        && config.forceRewrite === true
        && !context.shouldSerializeDirtyState
        && Boolean(context.expectedOriginalPath)
        && Boolean(context.expectedWorkingPath)
        && config.canPersistNativeWorkingCopy
    ) {
        return 'native-working-copy';
    }
    return 'native-mutations-or-serialized';
}
