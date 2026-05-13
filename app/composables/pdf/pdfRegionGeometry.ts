import { clamp } from 'es-toolkit/math';

export interface IClientRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface IClientPoint {
    clientX: number;
    clientY: number;
}

export interface ILocalRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IOverlayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function getRectWidth(rect: IClientRect) {
    return Math.max(0, rect.right - rect.left);
}

export function getRectHeight(rect: IClientRect) {
    return Math.max(0, rect.bottom - rect.top);
}

export function normalizeClientRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
): IClientRect {
    return {
        left: Math.min(startX, endX),
        top: Math.min(startY, endY),
        right: Math.max(startX, endX),
        bottom: Math.max(startY, endY),
    };
}

export function intersectClientRects(a: IClientRect, b: IClientRect): IClientRect | null {
    const intersection: IClientRect = {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };

    return getRectWidth(intersection) > 0 && getRectHeight(intersection) > 0
        ? intersection
        : null;
}

export function clampClientPointToRect(
    point: IClientPoint,
    rect: IClientRect,
): IClientPoint {
    return {
        clientX: clamp(point.clientX, rect.left, rect.right),
        clientY: clamp(point.clientY, rect.top, rect.bottom),
    };
}

export function unionClientRects(a: IClientRect, b: IClientRect): IClientRect {
    return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
    };
}

export function toLocalRect(rect: IClientRect, overlayRect: IOverlayRect): ILocalRect {
    return {
        x: rect.left - overlayRect.left,
        y: rect.top - overlayRect.top,
        width: getRectWidth(rect),
        height: getRectHeight(rect),
    };
}

export function toClientRect(rect: DOMRect): IClientRect {
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}
