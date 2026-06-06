import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';

export type TMarkupSubtypeHintSource = 'editor-live' | IAnnotationCommentSummary['source'];

export interface IMarkupSubtypeHint {
    subtype: TMarkupSubtype;
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
    consumed: boolean;
    annotationId?: string | null;
    color?: string | null;
    id?: string | null;
    pageMarkupIndex?: number | null;
    source?: TMarkupSubtypeHintSource | null;
}
