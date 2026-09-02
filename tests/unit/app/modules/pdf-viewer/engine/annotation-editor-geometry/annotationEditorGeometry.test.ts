import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyAnnotationHandleResize,
    annotationRectContainsPoint,
    createAnnotationRectFromPoints,
    createDefaultTextBoxRect,
    moveAnnotationRect,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

const rect: IAnnotationMarkerRect = {
    left: 0.2,
    top: 0.3,
    width: 0.4,
    height: 0.2,
};

function expectRect(actual: IAnnotationMarkerRect, expected: IAnnotationMarkerRect) {
    expect(actual.left).toBeCloseTo(expected.left);
    expect(actual.top).toBeCloseTo(expected.top);
    expect(actual.width).toBeCloseTo(expected.width);
    expect(actual.height).toBeCloseTo(expected.height);
}

describe('annotation editor geometry', () => {
    it('moves a rectangle without allowing it to leave the page', () => {
        expectRect(moveAnnotationRect(rect, 0.7, -0.5), {
            left: 0.6,
            top: 0,
            width: 0.4,
            height: 0.2,
        });
    });

    it('creates a bounded rectangle for a reverse drag and enforces its minimum size', () => {
        expectRect(createAnnotationRectFromPoints({
            x: 0.8,
            y: 0.7,
        }, {
            x: 0.2,
            y: 0.1,
        }, 0.1), {
            left: 0.2,
            top: 0.1,
            width: 0.6,
            height: 0.6,
        });
        expectRect(createAnnotationRectFromPoints({
            x: 0.99,
            y: 0.99,
        }, {
            x: 0.99,
            y: 0.99,
        }, 0.1), {
            left: 0.9,
            top: 0.9,
            width: 0.1,
            height: 0.1,
        });
    });

    it.each([
        [
            'nw',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.1,
                top: 0.1,
                width: 0.5,
                height: 0.4,
            },
        ],
        [
            'n',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.1,
                width: 0.4,
                height: 0.4,
            },
        ],
        [
            'ne',
            {
                x: 0.9,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.1,
                width: 0.7,
                height: 0.4,
            },
        ],
        [
            'e',
            {
                x: 0.9,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.7,
                height: 0.2,
            },
        ],
        [
            'se',
            {
                x: 0.9,
                y: 0.9,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.7,
                height: 0.6,
            },
        ],
        [
            's',
            {
                x: 0.1,
                y: 0.9,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.6,
            },
        ],
        [
            'sw',
            {
                x: 0.1,
                y: 0.9,
            },
            {
                left: 0.1,
                top: 0.3,
                width: 0.5,
                height: 0.6,
            },
        ],
        [
            'w',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.1,
                top: 0.3,
                width: 0.5,
                height: 0.2,
            },
        ],
    ] as const)('resizes from the %s handle while keeping the opposite edge fixed', (handle, point, expected) => {
        expectRect(applyAnnotationHandleResize(rect, handle, point), expected);
    });

    it('clamps an overlarge resize to the page and the minimum size', () => {
        expectRect(applyAnnotationHandleResize(rect, 'nw', {
            x: 2,
            y: 2,
        }, 0.1), {
            left: 0.5,
            top: 0.4,
            width: 0.1,
            height: 0.1,
        });
    });

    it('places a click-created text box around the pointer and keeps it on the page', () => {
        expectRect(createDefaultTextBoxRect({
            x: 0.99,
            y: 0.01,
        }, 0.3, 0.2), {
            left: 0.7,
            top: 0,
            width: 0.3,
            height: 0.2,
        });
    });

    it('detects points inside a bounded annotation rectangle', () => {
        expect(annotationRectContainsPoint(rect, {
            x: 0.2,
            y: 0.3,
        })).toBe(true);
        expect(annotationRectContainsPoint(rect, {
            x: 0.6,
            y: 0.5,
        })).toBe(true);
        expect(annotationRectContainsPoint(rect, {
            x: 0.61,
            y: 0.5,
        })).toBe(false);
        expect(annotationRectContainsPoint(rect, {
            x: 0.5,
            y: 0.51,
        })).toBe(false);
    });
});
