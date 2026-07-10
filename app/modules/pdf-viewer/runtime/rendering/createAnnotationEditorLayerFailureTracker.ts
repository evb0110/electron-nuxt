import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IAnnotationEditorLayerPageFailure,
    TAnnotationEditorLayerFailureReason,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';

const MAX_EDITOR_LAYER_RETRIES = 2;

export function createAnnotationEditorLayerFailureTracker(options: {
    failures: Map<number, IAnnotationEditorLayerPageFailure>;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    hasDocument: () => boolean;
}) {
    const report = (params: {
        cause: 'annotation-editor-layer-render-failed' | 'annotation-editor-layer-quarantined' | 'pdfjs-compatibility-unsupported';
        error: unknown;
        pageNumber: number;
        reason: TAnnotationEditorLayerFailureReason;
        retryable: boolean;
        attempts?: number;
    }) => options.renderSupervisor?.reportEvent({
        cause: params.cause,
        key: `annotation-editor-layer:${params.pageNumber}`,
        metadata: {
            attempts: params.attempts ?? null,
            errorMessage: params.error instanceof Error ? params.error.message : String(params.error),
            errorName: params.error instanceof Error ? params.error.name : null,
            hasDocument: options.hasDocument(),
            pageNumber: params.pageNumber,
            reason: params.reason,
            retryable: params.retryable,
        },
    });

    const recordAnnotationEditorLayerFailure = (
        pageNumber: number,
        reason: TAnnotationEditorLayerFailureReason,
        error: unknown,
    ) => {
        const attempts = (options.failures.get(pageNumber)?.attempts ?? 0) + 1;
        const failure: IAnnotationEditorLayerPageFailure = {
            pageNumber,
            reason,
            attempts,
            lastFailedAt: Date.now(),
            message: error instanceof Error ? error.message : String(error),
        };
        options.failures.set(pageNumber, failure);
        const retryable = attempts < MAX_EDITOR_LAYER_RETRIES && reason === 'render-error';
        report({
            cause: reason === 'pdfjs-compatibility-unsupported'
                ? 'pdfjs-compatibility-unsupported'
                : 'annotation-editor-layer-render-failed',
            error,
            pageNumber,
            reason,
            retryable,
            attempts,
        });
        if (!retryable) {
            report({
                cause: 'annotation-editor-layer-quarantined',
                error,
                pageNumber,
                reason,
                retryable: false,
                attempts,
            });
        }
        return {
            failure,
            retryable,
        };
    };

    return {
        clearAnnotationEditorLayerFailure: (pageNumber: number) => options.failures.delete(pageNumber),
        isAnnotationEditorLayerQuarantined: (pageNumber: number) => (
            (options.failures.get(pageNumber)?.attempts ?? 0) >= MAX_EDITOR_LAYER_RETRIES
        ),
        recordAnnotationEditorLayerFailure,
    };
}
