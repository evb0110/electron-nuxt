import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

function getBaseName(path: TDocumentRef | null) {
    if (!path) {
        return null;
    }
    return getDocumentRefBaseName(path);
}

export function resolveWorkspaceWindowTitle(state: {
    isDjvuMode: boolean;
    djvuSourcePath: TDocumentRef | null;
    fileName: string | null;
    pendingOpenDisplayName: string | null;
    fallbackTitle: string;
}) {
    if (state.pendingOpenDisplayName) {
        return state.pendingOpenDisplayName;
    }

    if (state.isDjvuMode && state.djvuSourcePath) {
        return getBaseName(state.djvuSourcePath) ?? state.fallbackTitle;
    }

    return state.fileName ?? state.fallbackTitle;
}
