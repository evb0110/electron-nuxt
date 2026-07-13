import {
    ALL_WORKSPACE_VIEWER_CHUNK_TARGETS,
    type TWorkspaceViewerChunkLoader,
    type TWorkspaceViewerChunkTarget,
} from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import { warmupDesktopViewerChunkTargets } from '@app/modules/workspace-shell/host/warmupDesktopViewerChunks';

type TWorkspaceChunkLoader = () => Promise<unknown>;

interface IPreloadStartupDocumentOpenChunksOptions {
    isDesktopRuntime: boolean;
    shouldPreloadWorkspace: boolean;
    workspaceLoader?: TWorkspaceChunkLoader;
    viewerLoaderOverrides?: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>>;
}

const loadDocumentWorkspace: TWorkspaceChunkLoader = () => (
    import('@app/modules/workspace-shell/components/DocumentWorkspace.vue')
);

export function preloadStartupDocumentOpenChunks(options: IPreloadStartupDocumentOpenChunksOptions) {
    const tasks: Array<Promise<unknown>> = [];
    if (options.shouldPreloadWorkspace) {
        tasks.push((options.workspaceLoader ?? loadDocumentWorkspace)());
    }
    if (options.isDesktopRuntime) {
        tasks.push(warmupDesktopViewerChunkTargets({
            targets: ALL_WORKSPACE_VIEWER_CHUNK_TARGETS,
            ...(options.viewerLoaderOverrides ? {loaderOverrides: options.viewerLoaderOverrides} : {}),
        }));
    }

    return tasks.length > 0 ? Promise.all(tasks) : null;
}
