import type { TTabUpdate } from '@app/types/tabs';
import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

function getBaseName(path: TDocumentRef | null) {
    if (!path) {
        return null;
    }
    return getDocumentRefBaseName(path);
}

export function resolveWorkspaceTabUpdate(state: {
    fileName: string | null;
    pendingOpenDisplayName: string | null;
    originalPath: TDocumentRef | null;
    isDirty: boolean;
    isDjvuMode: boolean;
    djvuSourcePath: TDocumentRef | null;
}): TTabUpdate {
    const displayName = state.pendingOpenDisplayName
        ?? (state.isDjvuMode && state.djvuSourcePath
            ? (getBaseName(state.djvuSourcePath) ?? state.fileName)
            : state.fileName);

    return {
        fileName: displayName,
        originalPath: state.isDjvuMode && state.djvuSourcePath ? state.djvuSourcePath : state.originalPath,
        isDirty: state.isDirty,
        isDjvu: state.isDjvuMode,
    };
}
