import type {
    Ref,
    WatchStopHandle,
} from 'vue';

interface IUsePdfAnnotationEditorLifecycleOptions<TDocument extends object> {
    pdfDocument: Ref<TDocument | null>;
    viewerContainer: Ref<HTMLElement | null>;
    initialize(): void;
    destroy(): void;
}

/**
 * Keeps PDF.js annotation editing attached to the pair that owns it.
 *
 * Startup restoration can publish the PDF proxy before Vue commits the viewer
 * element. Watching only the proxy loses that edge forever and leaves every
 * annotation editor layer disabled until the document is opened again.
 */
export const usePdfAnnotationEditorLifecycle = <TDocument extends object>(
    options: IUsePdfAnnotationEditorLifecycleOptions<TDocument>,
): WatchStopHandle => {
    let initializedDocument: TDocument | null = null;
    let initializedContainer: HTMLElement | null = null;

    return watch([
        options.pdfDocument,
        options.viewerContainer,
    ], ([
        document,
        container,
    ]) => {
        if (!document || !container) {
            if (initializedDocument || initializedContainer) {
                options.destroy();
                initializedDocument = null;
                initializedContainer = null;
            }
            return;
        }

        if (
            document === initializedDocument
            && container === initializedContainer
        ) {
            return;
        }

        if (initializedDocument || initializedContainer) {
            options.destroy();
        }
        options.initialize();
        initializedDocument = document;
        initializedContainer = container;
    }, {
        flush: 'sync',
        immediate: true,
    });
};
