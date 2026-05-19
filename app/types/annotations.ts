export type TAnnotationTool = 'none' | 'select' | 'highlight' | 'underline' | 'strikethrough' | 'text' | 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow' | 'stamp';

export type TMarkupSubtype = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';

export type TShapeType = 'rectangle' | 'circle' | 'line' | 'arrow' | 'polyline' | 'polygon';
export type TDrawableShapeType = Extract<TAnnotationTool, 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow'>;

export type TLineEndStyle = 'none' | 'openArrow' | 'closedArrow';
export type TEmbeddedPdfShapeSubtype = 'Square' | 'Circle' | 'Line' | 'PolyLine' | 'Polygon' | 'Ink';
export type TShapeResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export interface IShapePoint {
    x: number;
    y: number;
}

export interface IShapeAnnotation {
    id: string;
    type: TShapeType;
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    x2?: number | undefined;
    y2?: number | undefined;
    color: string;
    fillColor?: string | undefined;
    opacity: number;
    strokeWidth: number;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    source?: 'local' | 'embedded' | undefined;
    annotationId?: string | null | undefined;
    stableKey?: string | null | undefined;
    pdfSubtype?: TEmbeddedPdfShapeSubtype | null | undefined;
    lineStartStyle?: TLineEndStyle | undefined;
    lineEndStyle?: TLineEndStyle | undefined;
}

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightThickness: number;
    highlightFree: boolean;
    highlightShowAll: boolean;
    underlineColor: string;
    underlineOpacity: number;
    strikethroughColor: string;
    strikethroughOpacity: number;
    squigglyColor: string;
    squigglyOpacity: number;
    inkColor: string;
    inkOpacity: number;
    inkThickness: number;
    textColor: string;
    textSize: number;
    shapeColor: string;
    shapeFillColor: string;
    shapeOpacity: number;
    shapeStrokeWidth: number;
}

export interface IAnnotationEditorState {
    isEditing: boolean;
    isEmpty: boolean;
    hasSomethingToUndo: boolean;
    hasSomethingToRedo: boolean;
    hasSelectedEditor: boolean;
}

export interface IAnnotationModifiedPayload { forceDirty?: boolean }

export interface IAnnotationMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ILinkAnnotation {
    id: string;
    pageNumber: number;
    url: string;
    rect: IAnnotationMarkerRect;
}

export interface IAnnotationCommentSummary {
    id: string;
    stableKey: string;
    sortIndex?: number | null | undefined;
    pageIndex: number;
    pageNumber: number;
    text: string;
    kindLabel?: string | null | undefined;
    subtype?: string | null | undefined;
    author: string | null;
    modifiedAt: number | null;
    color: string | null;
    uid: string | null;
    annotationId: string | null;
    source: 'editor' | 'pdf';
    hasNote?: boolean | undefined;
    markerRect?: IAnnotationMarkerRect | null | undefined;
}
