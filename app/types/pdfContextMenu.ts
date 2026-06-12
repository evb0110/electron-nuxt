import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface IAnnotationContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

export interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}
