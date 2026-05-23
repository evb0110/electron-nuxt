import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    composeHighlightFragments,
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
});
