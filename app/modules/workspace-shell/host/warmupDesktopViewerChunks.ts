type TViewerChunkLoader = () => Promise<unknown>;

interface IDesktopViewerChunkWarmupOptions {
    isDesktopRuntime: boolean;
    loaders?: TViewerChunkLoader[];
}

const defaultViewerChunkLoaders: TViewerChunkLoader[] = [
    () => import('@app/modules/djvu-viewer/public'),
    () => import('@app/modules/native-pdf-viewer/public'),
];

/**
 * Warms the heavy document-viewer chunks (DjVu and native PDF) in the background after
 * desktop startup, so opening a document never waits on a local chunk fetch/parse.
 *
 * This is one mechanism of the app-wide code-splitting policy — "reserve statically,
 * fill asynchronously":
 *
 * - Layout-reserving UI (banners, skeletons, status surfaces, transition shells) must be
 *   statically imported so it exists on the first frame. Use granular
 *   `public/component-exports/*` entry points to pull a single component without dragging
 *   its whole feature module into the eager bundle.
 * - Heavy document engines and user-initiated tools (viewers, OCR, print, pdf-lib) stay
 *   behind `defineAsyncComponent`/dynamic `import()` so neither web visitors nor desktop
 *   cold start pay their parse cost up front. The same renderer build ships to the web
 *   (Vercel) and to Electron, so async boundaries must stay valid for both targets.
 * - On desktop the renderer is served from local disk, which makes chunk loads cheap but
 *   not free (fetch, parse, evaluate). Likely-needed chunks are therefore warmed early:
 *   `app.vue` blocks the startup overlay on the DocumentWorkspace preload and fires this
 *   helper non-blocking for the viewer engines.
 *
 * Web stays cold on purpose: prefetching both viewer engines would spend bandwidth on
 * visitors who may never open that document type.
 */
export function warmupDesktopViewerChunks(options: IDesktopViewerChunkWarmupOptions) {
    if (!options.isDesktopRuntime) {
        return null;
    }

    const loaders = options.loaders ?? defaultViewerChunkLoaders;
    return Promise.all(loaders.map(loadViewerChunk => loadViewerChunk()));
}
