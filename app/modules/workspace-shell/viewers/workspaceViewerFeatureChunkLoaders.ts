export type TWorkspaceViewerFeatureChunkTarget =
    | 'pdfjs'
    | 'native-pdf'
    | 'page-source';

export type TWorkspaceViewerChunkLoader = () => Promise<unknown>;

/** Async boundaries mounted inside DocumentViewerChassis. */
export const workspaceViewerFeatureChunkLoaders = {
    pdfjs: () => import('@app/modules/pdf-viewer/public/component-exports/pdfViewer'),
    'native-pdf': () => import('@app/modules/native-pdf-viewer/public/component-exports/nativePdfViewer'),
    'page-source': () => import('@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue'),
} satisfies Record<TWorkspaceViewerFeatureChunkTarget, TWorkspaceViewerChunkLoader>;
