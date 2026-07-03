import type {
    IMarkerRect,
    IPoint2D,
} from '@contracts/geometry';
import type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
    TAnnotationTool as TContractAnnotationTool,
    TDrawableShapeTool,
} from '@contracts/annotations';
export {
    ANNOTATION_TOOLS,
    DRAWABLE_SHAPE_TOOLS,
} from '@contracts/annotations';

export type TAnnotationTool = TContractAnnotationTool;

export type TAnnotationCommentsStatus = 'loading' | 'ready';

export type TMarkupSubtype = TPdfAnnotationMarkupSubtype;

export type TShapeType = TPdfAnnotationShapeType;
export type TDrawableShapeType = TDrawableShapeTool;

export type TLineEndStyle = TPdfAnnotationLineEndStyle;
export type TEmbeddedPdfShapeSubtype = TPdfAnnotationShapePdfSubtype;
export type TShapeResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export type IShapePoint = IPoint2D;

export interface IShapeAnnotation {
    id: string;
    type: TShapeType;
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    opacity: number;
    strokeWidth: number;
    x2?: number;
    y2?: number;
    fillColor?: string | undefined;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    source?: 'local' | 'embedded';
    annotationId?: string | null | undefined;
    stableKey?: string | null | undefined;
    pdfSubtype?: TEmbeddedPdfShapeSubtype | null;
    lineStartStyle?: TLineEndStyle | undefined;
    lineEndStyle?: TLineEndStyle | undefined;
    createdAt?: number | null;
    modifiedAt?: number | null;
}

export interface IAnnotationSettings {
    highlightColor: string;
    highlightOpacity: number;
    highlightThickness: number;
    highlightFreehandEnabled: boolean;
    showAllHighlights: boolean;
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
    // Separate app-routed history flags keep toolbar undo responsive when
    // PDF.js storage state events arrive after command registration.
    hasAppAnnotationUndoHistory?: boolean;
    hasAppAnnotationRedoHistory?: boolean;
}

export interface IAnnotationModifiedPayload { forceDirty?: boolean }

export type IAnnotationMarkerRect = IMarkerRect;

export interface ITextMarkupAnnotationProperties {
    id: string;
    pageIndex: number;
    subtype: TMarkupSubtype;
    color: string;
    markerRect: IAnnotationMarkerRect | null;
}

export interface ILinkAnnotation {
    id: string;
    pageNumber: number;
    url?: string;
    dest?: string | unknown[];
    rect: IAnnotationMarkerRect;
}

export interface IAnnotationCommentSummary {
    id: string;
    stableKey: string;
    sortIndex?: number | null;
    pageIndex: number;
    pageNumber: number;
    text: string;
    displayText?: string | null;
    previewText?: string | null;
    kindLabel?: string | null;
    subtype?: string | null | undefined;
    author: string | null;
    createdAt?: number | null;
    modifiedAt: number | null;
    color: string | null;
    colorEdited?: boolean | undefined;
    fillColor?: string | null;
    opacity?: number | null;
    strokeWidth?: number | null;
    uid: string | null;
    annotationId: string | null;
    annotationName?: string | null | undefined;
    source: 'editor' | 'pdf' | 'shape';
    hasNote?: boolean;
    markerRect?: IAnnotationMarkerRect | null | undefined;
}
