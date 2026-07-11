type TViewerChunkLoader = () => Promise<unknown>;

interface IDesktopViewerChunkWarmupOptions {
    isDesktopRuntime: boolean;
    loaders?: TViewerChunkLoader[];
}

interface IPrioritizedViewerChunkWarmupOptions {
    isDesktopRuntime: boolean;
    paths: readonly string[];
    djvuLoader?: TViewerChunkLoader;
    pdfLoader?: TViewerChunkLoader;
}

const defaultDjvuChunkLoader: TViewerChunkLoader = () => (
    import('@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue')
);
const defaultPdfChunkLoader: TViewerChunkLoader = () => (
    import('@app/modules/native-pdf-viewer/public/component-exports/nativePdfViewer')
);

const defaultViewerChunkLoaders: TViewerChunkLoader[] = [
    defaultDjvuChunkLoader,
    defaultPdfChunkLoader,
];

/** Loads only the viewer engine required by paths already handed to this renderer. */
export function warmupDesktopViewerChunkForPaths(options: IPrioritizedViewerChunkWarmupOptions) {
    if (!options.isDesktopRuntime || options.paths.length === 0) {
        return null;
    }

    const loaders = new Set<TViewerChunkLoader>();
    for (const path of options.paths) {
        const normalizedPath = path.toLowerCase().split(/[?#]/u, 1)[0] ?? '';
        if (normalizedPath.endsWith('.djvu') || normalizedPath.endsWith('.djv')) {
            loaders.add(options.djvuLoader ?? defaultDjvuChunkLoader);
        } else if (normalizedPath.endsWith('.pdf')) {
            loaders.add(options.pdfLoader ?? defaultPdfChunkLoader);
        }
    }
    return loaders.size > 0 ? Promise.all([...loaders].map(loadViewerChunk => loadViewerChunk())) : null;
}

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
 * - On desktop, pending external-open paths first warm only their matching engine. This
 *   all-engine helper is reserved for background warmup after that startup claim.
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
