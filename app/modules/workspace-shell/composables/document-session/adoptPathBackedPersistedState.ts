import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import { isPathPdfSource } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import type { ILazyHistoryBaseline } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';

interface IResolvedPathBaseline {
    baseline: ILazyHistoryBaseline;
    revisionInfo: IDocumentRevisionInfo;
}

export function hasNativePathBackedSource(state: IDocumentSessionState, path: TDocumentRef) {
    return [
        state.pdfSrc.value,
        state.pdfReloadSrc.value,
    ].some(source => {
        if (!isPathPdfSource(source)) {
            return false;
        }
        return source.path === path
            && state.isElectron.value
            && isNativeDocumentRef(path);
    });
}

export async function adoptStablePathBackedPersistedState(input: {
    state: IDocumentSessionState;
    path: TDocumentRef;
    resolveStableBaseline: () => Promise<IResolvedPathBaseline>;
    markCurrentHistoryEntryClean: (
        snapshot: Uint8Array | null,
        options?: {
            lazyBaseline?: ILazyHistoryBaseline;
            recordSnapshotChange?: boolean;
        },
    ) => Promise<void>;
}) {
    const {
        baseline,
        revisionInfo,
    } = await input.resolveStableBaseline();
    if (!input.state.isActiveWorkingCopy(input.path)) {
        return false;
    }

    const source = {
        kind: 'path' as const,
        path: input.path,
        size: baseline.size,
        revision: baseline.revision,
    };
    input.state.documentRevisionInfo.value = revisionInfo;
    input.state.documentRevisionToken.value = revisionInfo.token;
    input.state.pdfData.value = null;
    input.state.pdfSrc.value = source;
    input.state.pdfReloadSrc.value = source;
    await input.markCurrentHistoryEntryClean(null, {
        lazyBaseline: baseline,
        recordSnapshotChange: false,
    });
    return true;
}
