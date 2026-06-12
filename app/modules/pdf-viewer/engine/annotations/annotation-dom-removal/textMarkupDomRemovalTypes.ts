import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IHighlightVisualCandidate {
    axisOverlap: boolean;
    distance: number;
    iou: number;
    svg: SVGElement;
}

export interface ITextMarkupElementCandidate {
    axisOverlap: boolean;
    distance: number;
    element: HTMLElement;
    iou: number;
}

export interface ITextMarkupCandidateScore {
    axisOverlap: boolean;
    distance: number;
    iou: number;
    matched: boolean;
}

export interface ITextMarkupPageCandidateContext {
    pageContainer: HTMLElement;
    targetRects: IAnnotationMarkerRect[];
}

export interface ITextMarkupCandidateContext {
    annotationElements: HTMLElement[];
    getRectForElement: (
        pageContainer: HTMLElement,
        element: Element & { getBoundingClientRect: () => DOMRect; },
    ) => IAnnotationMarkerRect | null;
    pageContexts: ITextMarkupPageCandidateContext[];
}

export interface ITextMarkupColorReadResult {
    color: string;
    element: string;
    source: 'element' | 'visual-node';
}

export interface IEditedTextMarkupVisualOptions { highlightOpacity?: number | null | undefined }
