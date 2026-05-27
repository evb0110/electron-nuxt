import {
    usePdfViewerCore,
    type IUsePdfViewerCoreOptions,
} from '@app/modules/pdf-viewer-runtime/usePdfViewerCore';
import type { usePdfAppAnnotationHistory } from '@app/composables/pdf/usePdfAppAnnotationHistory';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer-runtime/rendering/usePdfPageRenderingController';

interface IUsePdfViewerCoreControllerOptions extends IUsePdfViewerCoreOptions {
    appAnnotationHistory: ReturnType<typeof usePdfAppAnnotationHistory>;
    setUndoPdfjsAnnotationHandler: (handler: () => void) => void;
    setRedoPdfjsAnnotationHandler: (handler: () => void) => void;
    setPageRenderStallRecoveryHandler: (handler: (payload: IPageRenderStallPayload) => void) => void;
}

export function usePdfViewerCoreController(options: IUsePdfViewerCoreControllerOptions) {
    const {
        appAnnotationHistory,
        setUndoPdfjsAnnotationHandler,
        setRedoPdfjsAnnotationHandler,
        setPageRenderStallRecoveryHandler,
        ...coreOptions
    } = options;

    const core = usePdfViewerCore(coreOptions);
    setUndoPdfjsAnnotationHandler(core.undoAnnotation);
    setRedoPdfjsAnnotationHandler(core.redoAnnotation);
    setPageRenderStallRecoveryHandler(core.handlePageRenderStall);

    function undoAnnotation() {
        if (appAnnotationHistory.canUndo.value) {
            appAnnotationHistory.undo({ undoPdfjs: core.undoAnnotation });
            return;
        }
        core.undoAnnotation();
    }

    function redoAnnotation() {
        if (appAnnotationHistory.canRedo.value) {
            appAnnotationHistory.redo({ redoPdfjs: core.redoAnnotation });
            return;
        }
        core.redoAnnotation();
    }

    return {
        ...core,
        undoAnnotation,
        redoAnnotation,
    };
}
