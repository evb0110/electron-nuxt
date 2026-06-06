import {
    describe,
    expect,
    it,
} from 'vitest';
import { findShapeAtPoint } from '@app/utils/pdf-viewer/pdf-shape-overlay-interactions/findShapeAtPoint';
import { getNormalizedSvgPointerCoords } from '@app/utils/pdf-viewer/pdf-shape-overlay-interactions/getNormalizedSvgPointerCoords';
import { hasPointerMovedPastThreshold } from '@app/utils/pdf-viewer/pdf-shape-overlay-interactions/hasPointerMovedPastThreshold';
import { resolveSvgPointerTarget } from '@app/utils/pdf-viewer/pdf-shape-overlay-interactions/resolveSvgPointerTarget';
import type { IShapeAnnotation } from '@app/types/annotations';

function createRect(left: number, top: number, width: number, height: number) {
    return {
        left,
        top,
        width,
        height,
    };
}

function createEventTarget<T extends object>(value: T): T & EventTarget {
    return {
        addEventListener: () => {},
        dispatchEvent: () => true,
        removeEventListener: () => {},
        ...value,
    };
}

describe('pdfShapeOverlayInteractions', () => {
    it('resolves pointer coordinates against the ancestor svg instead of the shape group bounds', () => {
        const svg = createEventTarget({
            closest: () => null,
            getBoundingClientRect: () => createRect(100, 200, 400, 200),
        });
        const group = createEventTarget({
            closest: (selector: string) => selector === 'svg' ? svg : null,
            getBoundingClientRect: () => createRect(220, 250, 40, 30),
        });

        const coords = getNormalizedSvgPointerCoords({
            currentTarget: group,
            target: group,
            clientX: 300,
            clientY: 260,
        });

        expect(coords).toEqual({
            x: 0.5,
            y: 0.3,
        });
    });

    it('falls back to the event target when currentTarget is missing', () => {
        const svg = createEventTarget({
            closest: () => null,
            getBoundingClientRect: () => createRect(0, 0, 200, 100),
        });
        const path = createEventTarget({
            closest: (selector: string) => selector === 'svg' ? svg : null,
            getBoundingClientRect: () => createRect(0, 0, 20, 10),
        });

        expect(resolveSvgPointerTarget({
            currentTarget: null,
            target: path,
        })).toBe(svg);
    });

    it('uses pixel movement when deciding whether a drag should start', () => {
        expect(hasPointerMovedPastThreshold(
            {
                clientX: 100,
                clientY: 200,
            },
            {
                clientX: 103,
                clientY: 203,
            },
            5,
        )).toBe(false);

        expect(hasPointerMovedPastThreshold(
            {
                clientX: 100,
                clientY: 200,
            },
            {
                clientX: 106,
                clientY: 200,
            },
            5,
        )).toBe(true);
    });

    it('finds a nearby polyline even when the click lands slightly off the exact SVG stroke', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-polyline',
            type: 'polyline',
            pageIndex: 0,
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.4,
            color: '#facc15',
            opacity: 1,
            strokeWidth: 8,
            points: [
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.25,
                },
                {
                    x: 0.55,
                    y: 0.4,
                },
            ],
        };

        expect(findShapeAtPoint({
            shapes: [shape],
            x: 0.42,
            y: 0.28,
            svgWidth: 1000,
            svgHeight: 1000,
        })?.id).toBe(shape.id);
    });

    it('finds a nearby point on any stroke of a multi-stroke polyline', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-ink',
            type: 'polyline',
            pageIndex: 0,
            x: 0.2,
            y: 0.2,
            width: 0.5,
            height: 0.4,
            color: '#60a5fa',
            opacity: 1,
            strokeWidth: 6,
            points: [
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.3,
                },
            ],
            strokes: [
                [
                    {
                        x: 0.2,
                        y: 0.2,
                    },
                    {
                        x: 0.4,
                        y: 0.3,
                    },
                ],
                [
                    {
                        x: 0.55,
                        y: 0.5,
                    },
                    {
                        x: 0.7,
                        y: 0.58,
                    },
                ],
            ],
        };

        expect(findShapeAtPoint({
            shapes: [shape],
            x: 0.63,
            y: 0.54,
            svgWidth: 1000,
            svgHeight: 1000,
        })?.id).toBe(shape.id);
    });

    it('lets clicks inside a closed shape resolve to that shape', () => {
        const shape: IShapeAnnotation = {
            id: 'shape-rectangle',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.25,
            color: '#22c55e',
            fillColor: undefined,
            opacity: 1,
            strokeWidth: 6,
        };

        expect(findShapeAtPoint({
            shapes: [shape],
            x: 0.32,
            y: 0.3,
            svgWidth: 1200,
            svgHeight: 800,
        })?.id).toBe(shape.id);
    });

    it('prefers the topmost matching shape when multiple shapes overlap', () => {
        const lowerShape: IShapeAnnotation = {
            id: 'shape-lower',
            type: 'line',
            pageIndex: 0,
            x: 0.1,
            y: 0.1,
            x2: 0.8,
            y2: 0.8,
            width: 0.7,
            height: 0.7,
            color: '#2563eb',
            opacity: 1,
            strokeWidth: 4,
        };
        const upperShape: IShapeAnnotation = {
            ...lowerShape,
            id: 'shape-upper',
            color: '#ef4444',
        };

        expect(findShapeAtPoint({
            shapes: [
                lowerShape,
                upperShape,
            ],
            x: 0.45,
            y: 0.45,
            svgWidth: 900,
            svgHeight: 900,
        })?.id).toBe(upperShape.id);
    });
});
