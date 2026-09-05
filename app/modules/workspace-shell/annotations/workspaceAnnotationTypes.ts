import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IShapeAnnotation } from '@app/types/annotations';
import type {
    IPdfLiveAnnotationChangeSummary,
    IPdfViewerSaveExpose,
} from '@app/modules/pdf-viewer/public';

export interface IWorkspacePdfViewerForAnnotationUtils {
    runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
    hasShapes?: boolean | Ref<boolean>;
    hasCanonicalAnnotationChanges?: () => boolean;
    hasCanonicalShapeChanges?: (() => boolean) | undefined;
    collectLiveAnnotationChanges?: (() => IPdfLiveAnnotationChangeSummary) | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

export interface IHasAnnotationChangesDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    savedAnnotationStorageFingerprint?: Ref<string | null>;
}
