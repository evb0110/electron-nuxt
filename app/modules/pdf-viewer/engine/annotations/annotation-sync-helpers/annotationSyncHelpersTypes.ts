import type { TComputeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';

export interface IPdfAnnotationRecord {
    id?: string;
    annotationName?: string | null;
    pageIndex?: number;
    rect?: number[];
    contents?: string;
    contentsObj?: { str?: string | null };
    richText?: { str?: string | null };
    title?: string;
    titleObj?: { str?: string | null };
    color?: ArrayLike<number> | string | null;
    opacity?: number;
    modificationDate?: string | null;
    creationDate?: string | null;
    subtype?: string;
    quadPoints?: ArrayLike<number> | null;
    popupRef?: string | null;
    url?: string;
    dest?: string | unknown[] | null;
}

export interface IPdfPageAnnotationBundle {
    annotations: IPdfAnnotationRecord[];
    pageView: number[] | null;
    pageRotation: TPageRotation;
    textItems?: IPdfTextPreviewItem[] | undefined;
    textViewport?: IPdfTextPreviewViewport | null | undefined;
}

export interface IPdfCommentSummaryDeps {
    computeStableKey: TComputeSummaryStableKey;
    resolveKindLabel: (subtype: string | null | undefined) => string;
}
