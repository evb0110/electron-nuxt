import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface IMarkerViewModel {
    annotation: IAnnotationCommentSummary;
    clustered: IAnnotationCommentSummary[];
    leftPercent: number;
    topPercent: number;
    isActive: boolean;
    preview: string;
    ariaLabel: string;
}

export interface IPagePointTarget {
    pageContainer: HTMLElement;
    pageNumber: number;
    pageX: number;
    pageY: number;
}
