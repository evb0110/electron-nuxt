import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface INormalizedRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IViewportRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IMarkerViewModel {
    annotation: IAnnotationCommentSummary;
    clustered: IAnnotationCommentSummary[];
    leftPercent: number;
    topPercent: number;
    isActive: boolean;
    preview: string;
    ariaLabel: string;
}

export interface ISpatialIndexEntry {
    annotation: IAnnotationCommentSummary;
    viewportRect: IViewportRect;
    pageNumber: number;
}

export interface IAnnotationStoreState {
    annotations: IAnnotationCommentSummary[];
    activeKey: string | null;
}

export interface IPagePointTarget {
    pageContainer: HTMLElement;
    pageNumber: number;
    pageX: number;
    pageY: number;
}
