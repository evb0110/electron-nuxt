import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    composeHighlightFragments,
    extractRectsFromHighlightPath,
    isRectangularHighlightPathData,
    shouldCompositeHighlightClassList,
    shouldCompositeHighlightSources,
} from '@app/composables/pdf/pdfHighlightCompositeOverlay';

function createSource(x: number, fill = '#ffff66') {
    return {
        x,
        y: 0,
        width: 50,
        height: 10,
        fill,
        opacity: '1',
    };
}

describe('pdfHighlightCompositeOverlay', () => {
    it('uses latest highlight color in intersections instead of overlapping colors', () => {
        const fragments = composeHighlightFragments([
            {
                x: 0,
                y: 0,
                width: 50,
                height: 10,
                fill: '#ffff66',
                opacity: '1',
            },
            {
                x: 25,
                y: 0,
                width: 50,
                height: 10,
                fill: '#a6e8ff',
                opacity: '1',
            },
        ]);

        expect(fragments.map(fragment => fragment.fill)).toEqual([
            '#ffff66',
            '#a6e8ff',
        ]);
        expect(fragments.map(fragment => [
            fragment.x,
            fragment.width,
        ])).toEqual([
            [
                0,
                25,
            ],
            [
                25,
                50,
            ],
        ]);
    });

    it('composites true text highlights but leaves markup subtypes to subtype rendering', () => {
        expect(shouldCompositeHighlightClassList(['highlight'])).toBe(true);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'free',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-markup-subtype-draw-underline',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-markup-subtype-draw-strikeout',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-layer-preserve-snapshot',
        ])).toBe(false);
    });

    it('only needs the overlay when text highlight sources overlap', () => {
        expect(shouldCompositeHighlightSources([createSource(0)])).toBe(false);
        expect(shouldCompositeHighlightSources([
            createSource(0),
            createSource(60, '#a6e8ff'),
        ])).toBe(false);
        expect(shouldCompositeHighlightSources([
            createSource(0),
            createSource(25, '#a6e8ff'),
        ])).toBe(true);
    });

    it('accepts paths that decompose into axis-aligned rectangles', () => {
        expect(isRectangularHighlightPathData('M0 0 V1 H1 V0 Z')).toBe(true);
        expect(isRectangularHighlightPathData('M0 0 V1 H1 V0 Z M2 0 V1 H3 V0 Z')).toBe(true);
        expect(isRectangularHighlightPathData('M0 0 V0.5 H1 V0.75 H0.2 V1 H0 Z')).toBe(false);
        expect(isRectangularHighlightPathData('M0 0 C 1 1 2 2 3 3 Z')).toBe(false);
    });

    it('extracts each axis-aligned subpath as its own rect', () => {
        expect(extractRectsFromHighlightPath('M0 0 V1 H1 V0 Z')).toEqual([{
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        }]);
        expect(extractRectsFromHighlightPath(
            'M0.35155187337702487 0.5164319248826291 V0 H1 V0.5164319248826291 Z'
            + ' M0 1 V0.48356807511737093 H0.2803264498577965 V1 Z',
        )).toEqual([
            {
                x: 0.35155187337702487,
                y: 0,
                width: 1 - 0.35155187337702487,
                height: 0.5164319248826291,
            },
            {
                x: 0,
                y: 0.48356807511737093,
                width: 0.2803264498577965,
                height: 1 - 0.48356807511737093,
            },
        ]);
        expect(extractRectsFromHighlightPath('M0 0 V0.5 H1 V0.75 H0.2 V1 H0 Z')).toBeNull();
    });

    it('composites overlapping multi-rect highlights so the latest color wins per fragment', () => {
        const blueSubpathA = {
            x: 400,
            y: 0,
            width: 600,
            height: 500,
            fill: '#a6e8ff',
            opacity: '1',
        };
        const blueSubpathB = {
            x: 0,
            y: 500,
            width: 400,
            height: 500,
            fill: '#a6e8ff',
            opacity: '1',
        };
        const yellowOverlap = {
            x: 450,
            y: 100,
            width: 300,
            height: 300,
            fill: '#ffff66',
            opacity: '1',
        };
        const fragments = composeHighlightFragments([
            blueSubpathA,
            blueSubpathB,
            yellowOverlap,
        ]);
        const overlapFragments = fragments.filter(fragment => fragment.fill === '#ffff66');
        const blueFragments = fragments.filter(fragment => fragment.fill === '#a6e8ff');
        expect(overlapFragments).toEqual([yellowOverlap]);
        expect(blueFragments.some(fragment => (
            fragment.x < yellowOverlap.x + yellowOverlap.width
            && fragment.x + fragment.width > yellowOverlap.x
            && fragment.y < yellowOverlap.y + yellowOverlap.height
            && fragment.y + fragment.height > yellowOverlap.y
        ))).toBe(false);
    });
});
