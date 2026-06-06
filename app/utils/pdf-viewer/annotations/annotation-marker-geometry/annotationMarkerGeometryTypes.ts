import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

export interface IDetachedMarkerPlacement {
    leftPercent: number;
    topPercent: number;
}

export interface IDetachedCommentCluster {
    anchorRect: IAnnotationMarkerRect;
    comments: IAnnotationCommentSummary[];
}

export interface IDetachedMarkerOccupied {
    x: number;
    y: number;
}
