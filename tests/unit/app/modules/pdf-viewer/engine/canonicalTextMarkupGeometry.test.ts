import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    matchCanonicalTextMarkupGeometry,
    TEXT_MARKUP_COORDINATE_TOLERANCE,
    toCanonicalTextMarkupGeometry,
    toCanonicalTextMarkupGeometryFromRecord,
    toCanonicalTextMarkupRect,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';
import { MIN_MARKER_RECT_SIZE } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';

const PAGE_VIEW = [
    0,
    0,
    612,
    792,
];

const LINE_RECT = {
    left: 0.25,
    top: 0.25,
    width: 0.3,
    height: 0.02,
};

describe('canonical text markup geometry', () => {
    it('is idempotent, so geometry normalized twice does not drift', () => {
        const rects = [
            LINE_RECT,
            {
                left: 0.5,
                top: 0.5,
                width: 0.0009,
                height: 0.02,
            },
            {
                left: 0.94,
                top: 0.5,
                width: 0.09,
                height: 0.02,
            },
            {
                left: 0.9995,
                top: 0.5,
                width: 0.0004,
                height: 0.0004,
            },
            {
                left: 0.2,
                top: -0.004,
                width: 0.2,
                height: 0.02,
            },
        ];
        rects.forEach((rect) => {
            const once = toCanonicalTextMarkupRect(rect);
            expect(once).not.toBeNull();
            expect(toCanonicalTextMarkupRect(once!)).toEqual(once);
        });
    });

    it('widens a fragment narrower than the minimum around its centre', () => {
        const canonical = toCanonicalTextMarkupRect({
            left: 0.5,
            top: 0.25,
            width: 0.0009,
            height: 0.02,
        });

        expect(canonical?.width).toBeCloseTo(MIN_MARKER_RECT_SIZE, 10);
        expect((canonical!.left + canonical!.width / 2)).toBeCloseTo(0.5 + 0.00045, 6);
    });

    it('keeps a rect that overhangs the page inside the page box', () => {
        const canonical = toCanonicalTextMarkupRect({
            left: 0.94,
            top: 0.25,
            width: 0.09,
            height: 0.02,
        });

        expect(canonical).toEqual({
            left: 0.94,
            top: 0.25,
            width: 0.06,
            height: 0.02,
        });
    });

    it('reads any quad corner order into the same rect', () => {
        const topLeftFirst = [
            100,
            700,
            200,
            700,
            100,
            686,
            200,
            686,
        ];
        const bottomRightFirst = [
            200,
            686,
            100,
            686,
            200,
            700,
            100,
            700,
        ];

        expect(toCanonicalTextMarkupGeometryFromRecord({quadPoints: topLeftFirst}, PAGE_VIEW, 0))
            .toEqual(toCanonicalTextMarkupGeometryFromRecord({quadPoints: bottomRightFirst}, PAGE_VIEW, 0));
    });

    it('normalizes against the page view origin', () => {
        const offsetView = [
            18,
            24,
            594,
            768,
        ];
        const [rect] = toCanonicalTextMarkupGeometryFromRecord({quadPoints: [
            18,
            768,
            306,
            768,
            18,
            744,
            306,
            744,
        ]}, offsetView, 0);

        expect(rect?.left).toBeCloseTo(0, 6);
        expect(rect?.top).toBeCloseTo(0, 6);
        expect(rect?.width).toBeCloseTo(0.5, 6);
    });

    it('reads a /Rect for markup saved without quad points', () => {
        expect(toCanonicalTextMarkupGeometryFromRecord({rect: [
            0,
            396,
            306,
            792,
        ]}, PAGE_VIEW, 0)).toEqual([{
            left: 0,
            top: 0,
            width: 0.5,
            height: 0.5,
        }]);
    });

    it('reads one rect per quad, so a multi-quad markup keeps every line', () => {
        const geometry = toCanonicalTextMarkupGeometryFromRecord({
            quadPoints: [
                90,
                600,
                300,
                600,
                90,
                586,
                300,
                586,
                90,
                584,
                260,
                584,
                90,
                570,
                260,
                570,
            ],
            // A bounding /Rect that spans both quads, as a writer emits.
            rect: [
                90,
                570,
                300,
                600,
            ],
        }, PAGE_VIEW, 0);

        expect(geometry).toHaveLength(2);
        expect(geometry[0]?.width).toBeCloseTo(210 / 612, 6);
        expect(geometry[1]?.width).toBeCloseTo(170 / 612, 6);
    });

    it('applies the page rotation both sides of verification share', () => {
        const quad = {quadPoints: [
            0,
            792,
            306,
            792,
            0,
            594,
            306,
            594,
        ]};

        expect(toCanonicalTextMarkupGeometryFromRecord(quad, PAGE_VIEW, 0)).toEqual([{
            left: 0,
            top: 0,
            width: 0.5,
            height: 0.25,
        }]);
        // A /Rotate 90 page displays the same quad along the other axis: the
        // upper-left quarter-height band becomes a left-edge quarter-width band.
        expect(toCanonicalTextMarkupGeometryFromRecord(quad, PAGE_VIEW, 90)).toEqual([{
            left: 0.75,
            top: 0,
            width: 0.25,
            height: 0.5,
        }]);
    });

    it('collapses an absurd quad array into one enclosing rect on both sides', () => {
        const quadOf = (index: number) => [
            90,
            700 - index,
            300,
            700 - index,
            90,
            699.5 - index,
            300,
            699.5 - index,
        ];
        const atCeiling = Array.from({length: 512}, (_unused, index) => quadOf(index)).flat();
        const pastCeiling = Array.from({length: 513}, (_unused, index) => quadOf(index)).flat();

        expect(toCanonicalTextMarkupGeometryFromRecord({quadPoints: atCeiling}, PAGE_VIEW, 0))
            .toHaveLength(512);
        const collapsed = toCanonicalTextMarkupGeometryFromRecord({quadPoints: pastCeiling}, PAGE_VIEW, 0);
        expect(collapsed).toHaveLength(1);
        // The single rect still encloses every quad, so a moved highlight moves it.
        expect(collapsed[0]?.left).toBeCloseTo(90 / 612, 6);
        expect(collapsed[0]?.width).toBeCloseTo(210 / 612, 6);
        expect(collapsed[0]?.height).toBeCloseTo(512.5 / 792, 6);
    });

    it('drops a non-finite corner as a whole pair when collapsing an absurd quad array', () => {
        const quadOf = (index: number) => [
            90,
            700 - index,
            300,
            700 - index,
            90,
            699.5 - index,
            300,
            699.5 - index,
        ];
        const quads = Array.from({length: 513}, (_unused, index) => quadOf(index)).flat();
        const clean = toCanonicalTextMarkupGeometryFromRecord({quadPoints: quads}, PAGE_VIEW, 0);
        // One corner of the first quad loses its y. Its three other corners
        // still span the same box, so the enclosing rect must not move; only a
        // parity shift — reading later x values as y values — could move it.
        const damaged = [...quads];
        damaged[1] = Number.NaN;

        const collapsed = toCanonicalTextMarkupGeometryFromRecord({quadPoints: damaged}, PAGE_VIEW, 0);

        expect(collapsed).toHaveLength(1);
        expect(collapsed).toEqual(clean);
        expect(collapsed[0]?.left).toBeCloseTo(90 / 612, 6);
        expect(collapsed[0]?.width).toBeCloseTo(210 / 612, 6);
        expect(collapsed[0]?.height).toBeCloseTo(512.5 / 792, 6);
    });

    it('collapses a quad array past the spread argument limit without losing an extreme', () => {
        // Four corners per quad, so the enclosing bounds of this array span far
        // more coordinates than a `Math.min(...xs)` call can pass as arguments.
        const quadCount = 75000;
        const quadPoints = new Float32Array(quadCount * 8);
        for (let index = 0; index < quadCount; index += 1) {
            // Every extreme sits at a different point of the array, so a scan
            // that stopped early or read only one end would miss one of them.
            const x0 = index === quadCount - 2 ? 60 : 100;
            const x1 = index === Math.floor(quadCount / 2) ? 500 : 300;
            const yTop = index === 1 ? 700 : 300.5;
            const yBottom = index === quadCount - 1 ? 50 : 300;
            quadPoints.set([
                x0,
                yTop,
                x1,
                yTop,
                x0,
                yBottom,
                x1,
                yBottom,
            ], index * 8);
        }

        const collapsed = toCanonicalTextMarkupGeometryFromRecord({quadPoints}, PAGE_VIEW, 0);

        expect(collapsed).toHaveLength(1);
        expect(collapsed[0]?.left).toBeCloseTo(60 / 612, 5);
        expect(collapsed[0]?.width).toBeCloseTo(440 / 612, 5);
        expect(collapsed[0]?.top).toBeCloseTo(92 / 792, 5);
        expect(collapsed[0]?.height).toBeCloseTo(650 / 792, 5);
    });

    it('drops trailing values that do not complete a quad', () => {
        expect(toCanonicalTextMarkupGeometryFromRecord({quadPoints: [
            100,
            700,
            200,
            700,
            100,
            686,
            200,
            686,
            100,
        ]}, PAGE_VIEW, 0)).toHaveLength(1);
    });

    it('matches reordered geometry without matching moved geometry', () => {
        const first = {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.02,
        };
        const second = {
            left: 0.35,
            top: 0.2,
            width: 0.2,
            height: 0.02,
        };
        const expected = toCanonicalTextMarkupGeometry([
            first,
            second,
        ]);

        expect(matchCanonicalTextMarkupGeometry(expected, toCanonicalTextMarkupGeometry([
            second,
            first,
        ])).matched).toBe(true);
        const moved = matchCanonicalTextMarkupGeometry(expected, toCanonicalTextMarkupGeometry([
            first,
            {
                ...second,
                left: second.left + 0.01,
            },
        ]));
        expect(moved.matched).toBe(false);
        expect(moved.maxCoordinateDelta).toBeCloseTo(0.01, 6);
        expect(moved.worstRectIndex).toBe(1);
    });

    it('accepts a difference at the tolerance and rejects one past it', () => {
        const expected = toCanonicalTextMarkupGeometry([LINE_RECT]);
        const withinTolerance = toCanonicalTextMarkupGeometry([{
            ...LINE_RECT,
            left: LINE_RECT.left + TEXT_MARKUP_COORDINATE_TOLERANCE,
        }]);
        const pastTolerance = toCanonicalTextMarkupGeometry([{
            ...LINE_RECT,
            left: LINE_RECT.left + TEXT_MARKUP_COORDINATE_TOLERANCE * 2,
        }]);

        expect(matchCanonicalTextMarkupGeometry(expected, withinTolerance).matched).toBe(true);
        expect(matchCanonicalTextMarkupGeometry(expected, pastTolerance).matched).toBe(false);
    });

    it('reports a count difference instead of pairing what is left', () => {
        const match = matchCanonicalTextMarkupGeometry(
            toCanonicalTextMarkupGeometry([
                LINE_RECT,
                {
                    ...LINE_RECT,
                    left: 0.6,
                },
            ]),
            toCanonicalTextMarkupGeometry([LINE_RECT]),
        );

        expect(match.countMatches).toBe(false);
        expect(match.matched).toBe(false);
        expect(match.expectedCount).toBe(2);
        expect(match.reopenedCount).toBe(1);
    });
});
