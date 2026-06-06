import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/pageRotation';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/utils/pdf-viewer/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';

export interface IPdfAnnotationRecord {
    id?: string;
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
}

export interface IPdfPageAnnotationBundle {
    annotations: IPdfAnnotationRecord[];
    pageView: number[] | null;
    pageRotation: TPageRotation;
    textItems?: IPdfTextPreviewItem[] | undefined;
    textViewport?: IPdfTextPreviewViewport | null | undefined;
}

export interface IComputeSummaryStableKeyParams {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
}

export type TComputeSummaryStableKey = (params: IComputeSummaryStableKeyParams) => string;

export interface IPdfCommentSummaryDeps {
    computeStableKey: TComputeSummaryStableKey;
    resolveKindLabel: (subtype: string | null | undefined) => string;
}
