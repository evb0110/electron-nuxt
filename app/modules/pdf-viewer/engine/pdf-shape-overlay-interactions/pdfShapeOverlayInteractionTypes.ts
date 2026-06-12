export interface IPointerEventLike {
    currentTarget: EventTarget | null;
    target: EventTarget | null;
    clientX: number;
    clientY: number;
}

export interface IShapeOverlayBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
