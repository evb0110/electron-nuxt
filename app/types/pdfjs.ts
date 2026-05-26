import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IPdfjsHighlightBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPdfjsDrawLayerDrawProperties {
    bbox?: [number, number, number, number];
    root?: Record<string, string | null>;
    rootClass?: Record<string, boolean>;
    path?: Record<string, string | null>;
}

export interface IPdfjsDrawLayer {
    draw: (
        properties?: IPdfjsDrawLayerDrawProperties,
        isPathUpdatable?: boolean,
        hasClip?: boolean,
    ) => {
        clipPathId?: string;
        id: number;
    };
    remove: (id: number) => void;
}

export interface IPdfjsEditorParent {
    div?: HTMLElement;
    drawLayer?: IPdfjsDrawLayer;
}

export interface IPdfjsEditor {
    id?: string;
    div?: HTMLElement;
    uid?: string;
    annotationElementId?: string | null;
    comment?: string | {
        text?: string | null;
        deleted?: boolean | null;
    } | null;
    hasComment?: boolean;
    color?: string | number[] | null;
    opacity?: number;
    parentPageIndex?: number;
    pageDimensions?: [number, number];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    isSelected?: boolean;
    _isDraggable?: boolean;
    _onResized?: () => void;
    _onResizing?: () => void;
    isInEditMode?: () => boolean;
    updateParams?: (type: number, value: unknown) => void;
    onUpdatedColor?: () => void;
    setDims?: () => void;
    fixAndSetPosition?: () => void;
    parent?: IPdfjsEditorParent;
    __evbPendingAnchorRect?: IAnnotationMarkerRect | null;
    __evbResolvedPageIndex?: number;
    __evbPlacementAttemptId?: string | null;
    __evbMarkupSubtypeColor?: string | null;
    __evbMarkupBoxes?: IPdfjsHighlightBox[] | null;
    __evbSelectionText?: string | null;
    getData?: () => {
        modificationDate?: string | null;
        creationDate?: string | null;
        color?: string | number[] | null;
        opacity?: number;
    };
    toggleComment?: (isSelected: boolean, visibility?: boolean) => void;
    addToAnnotationStorage?: () => void;
    focusCommentButton?: () => void;
    remove?: () => void;
    delete?: () => void;
    isEmpty?: () => boolean;
}

export interface IPdfjsEditorWithEditComment extends IPdfjsEditor {editComment: () => void;}

export interface IPdfjsEditorConstructorLike {updateDefaultParams?: (type: number, value: unknown) => void;}

export interface IPdfjsEditorLayerWithGetEditorByUid {getEditorByUID: (uid: string) => unknown;}

export interface IPdfjsAnnotationEditorLayer {
    div: HTMLElement;
    createAndAddNewEditor: (
        event: PointerEvent,
        isCentered: boolean,
        data?: Record<string, unknown>,
    ) => unknown;
}
