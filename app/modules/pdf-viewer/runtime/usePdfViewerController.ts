import type {
    IPdfViewerProps,
    TPdfViewerEmit,
} from './contracts/pdfViewerComponent.types';
import { usePdfViewerFeatureController } from './usePdfViewerFeatureController';

export function usePdfViewerController(props: IPdfViewerProps, emit: TPdfViewerEmit) {
    return usePdfViewerFeatureController(props, emit);
}
