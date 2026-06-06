import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platformApi';
import type { IShapeAnnotation } from '@app/types/annotations';

export interface IWorkspacePdfViewerForAnnotationUtils {
    saveDocument: () => Promise<Uint8Array | null>;
    hasShapes?: boolean | Ref<boolean>;
    getAllShapes: () => IShapeAnnotation[];
}

export interface ISerializeEmbeddedFallbackDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromData: (
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) => Promise<void>;
}

export interface IHasAnnotationChangesDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    savedAnnotationStorageFingerprint?: Ref<string | null>;
}
