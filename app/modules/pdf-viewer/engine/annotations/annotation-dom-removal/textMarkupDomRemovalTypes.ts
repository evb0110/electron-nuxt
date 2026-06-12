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

export interface ITextMarkupColorReadResult {
    color: string;
    element: string;
    source: 'element' | 'visual-node';
}

export interface IEditedTextMarkupVisualOptions { highlightOpacity?: number | null | undefined }
