import {SCAN_CLEANUP_WARNING_EVENT_CODES} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {TScanCleanupWarningEvent} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    describeScanCleanupNativeWarnings,
    formatScanCleanupWarningEvent,
    toScanCleanupPercentTenths,
} from '@scan-cleanup-core/policy/scanCleanupWarningEvents';
import {
    describe,
    expect,
    it,
} from 'vitest';

// Every sentence a scan-cleanup run can say about a placement, pinned. These
// strings are what the raster, lossless, and preview paths displayed before the
// warning transport became structured, and they may only change with a separate
// copy decision.
const PINNED: Array<[TScanCleanupWarningEvent, string]> = [
    [
        {
            code: 'matched-canvas-content-fitted',
            unit: 'px',
            contentWidth: 600,
            contentHeight: 500,
            innerWidth: 952,
            innerHeight: 952,
            documentCanvasWidth: 1_000,
            documentCanvasHeight: 1_000,
        },
        'Matched page size fitted this page to 600x500 px inside the 952x952 px requested margin box '
        + 'on the 1000x1000 px document canvas, below the document\'s scale',
    ],
    [
        {
            code: 'matched-canvas-content-fitted',
            unit: 'px',
            contentWidth: 196,
            contentHeight: 180,
            innerWidth: 196,
            innerHeight: 180,
        },
        'Matched page size fitted this page to 196x180 px inside the 196x180 px margin box, '
        + 'below the document\'s scale',
    ],
    [
        {
            code: 'matched-canvas-content-fitted',
            unit: 'pt',
            contentWidth: 343.25,
            contentHeight: 171.7,
            innerWidth: 371.7,
            innerHeight: 171.7,
        },
        'Matched page size fitted this page to 343.3x171.7 pt inside the 371.7x171.7 pt margin box, '
        + 'below the document\'s scale',
    ],
    [
        {
            code: 'matched-canvas-content-fitted-pages',
            pages: [
                1,
                2,
                5,
            ],
        },
        'Matched page size fitted 3 page(s) inside their requested margin boxes, '
        + 'below the document\'s scale: 1, 2, 5',
    ],
    [
        {code: 'matched-canvas-margins-reduced'},
        'Matched page size reduced requested margins because they leave no drawable canvas',
    ],
    [
        {code: 'matched-canvas-margins-unavailable'},
        'Requested margins were not applied because content detection or cropping is unavailable',
    ],
    [
        {
            code: 'matched-canvas-paper-downscaled',
            unit: 'px',
            scalePercentTenths: 500,
            documentCanvasWidth: 50,
            documentCanvasHeight: 100,
        },
        'Matched page size placed this page at 50.0% of the document\'s scale because its paper is '
        + 'larger than the 50x100 px document canvas, which was measured from a different layout for this page',
    ],
    [
        {
            code: 'matched-canvas-paper-downscaled',
            unit: 'pt',
            scalePercentTenths: 500,
            documentCanvasWidth: 200,
            documentCanvasHeight: 100,
            paperWidth: 400,
            paperHeight: 200,
        },
        'Matched page size placed this page at 50.0% of the document\'s scale because its '
        + '400.0x200.0 pt paper is larger than the 200.0x100.0 pt document canvas, '
        + 'which was measured from a different layout for this page',
    ],
    [
        {code: 'matched-canvas-optical-centering-fallback'},
        'Optical centering was requested but the optical bounds could not fit inside the canvas margins; '
        + 'raster alignment was retained',
    ],
    [
        {
            code: 'matched-canvas-intrinsic-overflow',
            leftPx: 7,
            rightPx: 3,
        },
        'Matched page raster extends beyond the canvas by 7 px on the left and 3 px on the right; '
        + 'optical content remains bounded',
    ],
    [
        {
            code: 'matched-canvas-spread-headroom-trimmed',
            topPx: 12,
        },
        'Matched spread placement trimmed 12 px of source headroom above the shared content anchor',
    ],
    [
        {
            code: 'matched-canvas-fold-columns-discarded',
            leftColumns: 5,
            rightColumns: 9,
        },
        'Matched spread discarded 5 provably-paper fold-side columns on the left and 9 on the right '
        + '(all samples met the leaf-specific paper bound) before overflow fitting',
    ],
    [
        {code: 'matched-canvas-dropped'},
        'Matched page size was dropped: this document carries no readable page geometry',
    ],
    [
        {
            code: 'matched-canvas-geometry-unmeasured',
            detail: 'pdfinfo exited with 1',
        },
        'Matched page size is off for this document: its page geometry could not be measured '
        + '(pdfinfo exited with 1). Pages are previewed and cleaned at their own size.',
    ],
    [
        {
            code: 'matched-canvas-pages-resampled',
            pages: [2],
        },
        'Matched page size re-rendered 1 page(s) that do not share the document\'s pixel grid: 2',
    ],
    [
        {
            code: 'matched-canvas-pages-scaled-in-place',
            pages: [1],
        },
        'Matched page size scaled 1 page(s) that carry their own raster without re-rendering them: 1',
    ],
    [
        {
            code: 'matched-canvas-document-dpi-normalized',
            canvasDpi: 299.6,
            finestPageDpi: 400.2,
        },
        'Matched page size normalized this document at 300 DPI instead of the 400 DPI its finest page '
        + 'was rendered at, to keep one shared page inside the output pixel budget',
    ],
    [
        {
            code: 'matched-canvas-page-dpi-capped',
            pageNumber: 3,
            appliedDpi: 200,
            requestedDpi: 300,
        },
        'Matched page size capped page 3 at 200 DPI from 300 DPI to keep its uniform canvas '
        + 'inside cleanup guardrails',
    ],
    [
        {
            code: 'render-dpi-limited',
            appliedDpiThousandths: 288_500,
            requestedDpiThousandths: 400_000,
        },
        'Requested render DPI 400.000 was limited to 288.500 by native raster safety limits',
    ],
];

describe('scan cleanup warning events', () => {
    it.each(PINNED)('reproduces the pinned wording of %s', (event, expected) => {
        expect(formatScanCleanupWarningEvent(event)).toBe(expected);
    });

    it('pins one wording per warning code the catalog declares', () => {
        expect(new Set(PINNED.map(([event]) => event.code)))
            .toEqual(new Set(SCAN_CLEANUP_WARNING_EVENT_CODES));
    });

    it('carries the per-page prefix the raster and lossless summaries report with', () => {
        expect(formatScanCleanupWarningEvent({code: 'matched-canvas-margins-reduced'}, 7))
            .toBe('Page 7: Matched page size reduced requested margins because they leave no drawable canvas');
    });

    it('names a document\'s pages up to the reported limit and counts the rest', () => {
        expect(formatScanCleanupWarningEvent({
            code: 'matched-canvas-content-fitted-pages',
            pages: Array.from({length: 22}, (_, index) => index + 1),
        })).toBe('Matched page size fitted 22 page(s) inside their requested margin boxes, '
            + 'below the document\'s scale: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, '
            + '19, 20 and 2 more');
    });

    it('spells the digits its producer quantized rather than rounding a float itself', () => {
        // Both values are exact halves at the precision their sentence shows.
        // The sidecar resolved such a half to the even digit; a formatter
        // handed the raw float would resolve it away from zero instead, so the
        // same measurement would read differently depending on the language.
        expect((875.0625).toFixed(3)).toBe('875.063');
        expect((12.25).toFixed(1)).toBe('12.3');
        expect(formatScanCleanupWarningEvent({
            code: 'render-dpi-limited',
            appliedDpiThousandths: 875_062,
            requestedDpiThousandths: 1_200_000,
        })).toBe('Requested render DPI 1200.000 was limited to 875.062 by native raster safety limits');
        expect(formatScanCleanupWarningEvent({
            code: 'matched-canvas-paper-downscaled',
            unit: 'px',
            scalePercentTenths: 122,
            documentCanvasWidth: 50,
            documentCanvasHeight: 100,
        })).toContain('at 12.2% of the document\'s scale');
        // Fixed point is digits, not arithmetic: a value below one quantum
        // keeps its leading zeroes and a whole value keeps its trailing ones.
        expect(formatScanCleanupWarningEvent({
            code: 'render-dpi-limited',
            appliedDpiThousandths: 5,
            requestedDpiThousandths: 300_000,
        })).toBe('Requested render DPI 300.000 was limited to 0.005 by native raster safety limits');
        expect(formatScanCleanupWarningEvent({
            code: 'matched-canvas-paper-downscaled',
            unit: 'px',
            scalePercentTenths: 0,
            documentCanvasWidth: 50,
            documentCanvasHeight: 100,
        })).toContain('at 0.0% of the document\'s scale');
    });

    it('quantizes a JavaScript producer\'s percentage to the digit it has always printed', () => {
        for (const percent of [
            50,
            12.25,
            33.35,
            0.05,
            99.99,
            0,
            100,
        ]) {
            expect(formatScanCleanupWarningEvent({
                code: 'matched-canvas-paper-downscaled',
                unit: 'px',
                scalePercentTenths: toScanCleanupPercentTenths(percent),
                documentCanvasWidth: 50,
                documentCanvasHeight: 100,
            })).toContain(`at ${percent.toFixed(1)}% of the document's scale`);
        }
    });

    it('reports structured conditions before unstructured native diagnostics', () => {
        expect(describeScanCleanupNativeWarnings({
            warnings: ['Content crop was skipped because no content box was detected'],
            warningEvents: [{code: 'matched-canvas-margins-reduced'}],
        }, 2)).toEqual([
            'Page 2: Matched page size reduced requested margins because they leave no drawable canvas',
            'Page 2: Content crop was skipped because no content box was detected',
        ]);
        expect(describeScanCleanupNativeWarnings({})).toEqual([]);
    });
});
