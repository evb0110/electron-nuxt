import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IWordLossBaselineCap {
    maxComponents: number;
    maxFraction: number;
    reason: string;
}

type TWordLossBaseline = Record<number, IWordLossBaselineCap> | null;

interface IScanCleanupRegressModule {
    parseWordLossBaseline: (
        value: unknown,
        name: string,
        pages: number[] | undefined,
    ) => TWordLossBaseline;
    validateWordLossReport: (
        report: Record<string, unknown>,
        name: string,
        pages: number[] | undefined,
        baseline: TWordLossBaseline,
    ) => void;
    wordLossFailOn: (baseline: TWordLossBaseline) => 'any' | 'none';
}

const {
    parseWordLossBaseline,
    validateWordLossReport,
    wordLossFailOn,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/scan-cleanup-regress.mjs')).href
) as IScanCleanupRegressModule;

const baselineValue = {inventedInk: {'2': {
    maxComponents: 1,
    maxFraction: 0.017,
    reason: 'Source-supported header rule restored across scan gaps.',
}}};

function reportRow(overrides: Record<string, unknown> = {}) {
    return {
        flagged: true,
        inventedCount: 1,
        inventedFlagged: true,
        inventedInkFraction: 0.015125,
        lossFlagged: false,
        page: 2,
        silhouetteFlagged: false,
        status: 'analyzed',
        ...overrides,
    };
}

function reportWithRows(rows: Array<Record<string, unknown>>) {
    const flaggedPages = rows.filter(row => row.flagged === true).map(row => row.page);
    const inventedPages = rows.filter(row => row.inventedFlagged === true).map(row => row.page);
    const silhouettePages = rows.filter(row => row.silhouetteFlagged === true).map(row => row.page);
    const errorPages = rows.filter(row => row.status === 'error').map(row => row.page);
    return {
        pages: rows,
        stampVerification: {status: 'valid'},
        summary: {
            errorPages,
            flaggedCount: flaggedPages.length,
            flaggedPages,
            inventedPages,
            silhouettePages,
        },
    };
}

describe('scan-cleanup regress word-loss baselines', () => {
    it('keeps fail-on-any as the default and parses a narrow documented cap', () => {
        expect(wordLossFailOn(null)).toBe('any');
        const baseline = parseWordLossBaseline(baselineValue, 'linguae', [
            1,
            2,
        ]);
        expect(wordLossFailOn(baseline)).toBe('none');
        expect(baseline).toEqual({2: {
            maxComponents: 1,
            maxFraction: 0.017,
            reason: 'Source-supported header rule restored across scan gaps.',
        }});
    });

    it('accepts only the inspected invented-ink result or a resolved page', () => {
        const baseline = parseWordLossBaseline(baselineValue, 'linguae', undefined);
        expect(() => validateWordLossReport(
            reportWithRows([reportRow()]),
            'linguae',
            undefined,
            baseline,
        )).not.toThrow();
        expect(() => validateWordLossReport(
            reportWithRows([reportRow({
                flagged: false,
                inventedCount: 0,
                inventedFlagged: false,
                inventedInkFraction: 0,
            })]),
            'linguae',
            undefined,
            baseline,
        )).not.toThrow();
    });

    it.each([
        [
            'component cap',
            [reportRow({inventedCount: 2})],
        ],
        [
            'fraction cap',
            [reportRow({inventedInkFraction: 0.017001})],
        ],
        [
            'unlisted page',
            [
                reportRow(),
                reportRow({page: 3}),
            ],
        ],
        [
            'text loss',
            [reportRow({
                inventedFlagged: false,
                lossFlagged: true,
            })],
        ],
        [
            'silhouette',
            [reportRow({
                inventedFlagged: false,
                silhouetteFlagged: true,
            })],
        ],
        [
            'error row',
            [reportRow({status: 'error'})],
        ],
        [
            'duplicate row',
            [
                reportRow(),
                reportRow(),
            ],
        ],
    ])('rejects a %s', (_label, rows) => {
        const baseline = parseWordLossBaseline(baselineValue, 'linguae', undefined);
        expect(() => validateWordLossReport(
            reportWithRows(rows),
            'linguae',
            undefined,
            baseline,
        )).toThrow();
    });

    it('rejects missing rows and malformed or out-of-selection baselines', () => {
        const baseline = parseWordLossBaseline(baselineValue, 'linguae', undefined);
        expect(() => validateWordLossReport(
            reportWithRows([reportRow({
                flagged: false,
                inventedCount: 0,
                inventedFlagged: false,
                inventedInkFraction: 0,
                page: 1,
            })]),
            'linguae',
            undefined,
            baseline,
        )).toThrow(/missing/u);
        expect(() => parseWordLossBaseline({
            ...baselineValue,
            unknown: true,
        }, 'linguae', undefined)).toThrow(/unknown/u);
        expect(() => parseWordLossBaseline({inventedInk: {'02': baselineValue.inventedInk['2']}}, 'linguae', undefined)).toThrow(/canonical/u);
        expect(() => parseWordLossBaseline(baselineValue, 'linguae', [1])).toThrow(/selected/u);
        expect(() => parseWordLossBaseline({inventedInk: {'2': {
            ...baselineValue.inventedInk['2'],
            maxFraction: Number.NaN,
        }}}, 'linguae', undefined)).toThrow(/maxFraction/u);
    });

    it('preserves fail-closed validation when no baseline is configured', () => {
        expect(() => validateWordLossReport(
            reportWithRows([reportRow()]),
            'strict-fixture',
            undefined,
            null,
        )).toThrow(/flagged/u);
        expect(() => validateWordLossReport(
            reportWithRows([reportRow({
                flagged: false,
                inventedCount: 0,
                inventedFlagged: false,
                inventedInkFraction: 0,
            })]),
            'strict-fixture',
            undefined,
            null,
        )).not.toThrow();
    });
});
