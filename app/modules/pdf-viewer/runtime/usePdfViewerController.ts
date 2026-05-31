import type {
    IPdfViewerProps,
    TPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerFeatureController } from '@app/modules/pdf-viewer/runtime/usePdfViewerFeatureController';

export function usePdfViewerController(props: IPdfViewerProps, emit: TPdfViewerEmit) {
    return usePdfViewerFeatureController(props, emit);
}
