import type { IAnnotationMarkerRect } from '@app/types/annotations';

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
    setDims?: () => void;
    fixAndSetPosition?: () => void;
    parent?: { div?: HTMLElement };
    __evbPendingAnchorRect?: IAnnotationMarkerRect | null;
    __evbResolvedPageIndex?: number;
    __evbPlacementAttemptId?: string | null;
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
