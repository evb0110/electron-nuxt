import {
    alignBitmapForComparison,
    auditExitCode,
    buildExpectationInfos,
    buildExpectedMapping,
    measureComponentSurvival,
    measureFacingMarginAsymmetry,
    measureSpreadLeafScale,
    measureSpreadLeafVerticalAlignment,
    summarizeMeasurementCoverage,
} from '@scripts/diagnostics/scan-cleanup-representative-audit.mjs';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {
    describe,
    expect,
    it,
} from 'vitest';

function makeSyntheticBitmap(offsetX = 0, includeContent = true) {
    const width = 160;
    const height = 224;
    const data = new Uint8Array(width * height).fill(255);
    const rectangles = includeContent
        ? [
            {
                bottom: 64,
                left: 16,
                right: 48,
                top: 24,
            },
            {
                bottom: 128,
                left: 72,
                right: 120,
                top: 88,
            },
            {
                bottom: 200,
                left: 40,
                right: 88,
                top: 160,
            },
        ]
        : [];
    for (const {
        bottom,
        left,
        right,
        top,
    } of rectangles) {
        for (let y = top; y < bottom; y += 1) {
            for (let x = left + offsetX; x < right + offsetX; x += 1) {
                if (x >= 0 && x < width) {
                    data[y * width + x] = 0;
                }
            }
        }
    }
    return {
        data,
        height,
        width,
    };
}

function makeContentTopBitmap(top: number, contentValue = 0, span = 80) {
    const width = 160;
    const height = 224;
    const data = new Uint8Array(width * height).fill(255);
    for (let y = top; y < top + span; y += 1) {
        for (let x = 20; x < 140; x += 1) {
            data[y * width + x] = contentValue;
        }
    }
    return {
        data,
        height,
        width,
    };
}

function makeHorizontalMarginBitmap(leftMargin: number, rightMargin: number) {
    const width = 160;
    const height = 224;
    const data = new Uint8Array(width * height).fill(255);
    for (let y = 48; y < 176; y += 1) {
        for (let x = leftMargin; x < width - rightMargin; x += 1) {
            data[y * width + x] = 0;
        }
    }
    return {
        data,
        height,
        width,
    };
}

async function makePngBitmap({
    height = 240,
    rectangles,
    width = 120,
}: {
    height?: number;
    rectangles: Array<{
        height: number;
        width: number;
        x: number;
        y: number;
    }>;
    width?: number;
}) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    for (const rectangle of rectangles) {
        context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
    const png = canvas.toBuffer('image/png');
    const decoded = await loadImage(png);
    const decodedCanvas = createCanvas(width, height);
    const decodedContext = decodedCanvas.getContext('2d');
    decodedContext.drawImage(decoded, 0, 0);
    const rgba = decodedContext.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let index = 0; index < data.length; index += 1) {
        data[index] = rgba[index * 4] ?? 255;
    }
    return {
        data,
        height,
        width,
    };
}

describe('scan cleanup representative audit mapping inference', () => {
    it('uses rendered output count to choose whole-page versus split mapping', () => {
        const wholePage = buildExpectedMapping(1, 1);
        expect(wholePage.entries).toEqual([{
            cleanedPage: 1,
            side: 'whole',
            sourcePage: 1,
            sourceLayout: 'single',
        }]);
        expect(buildExpectationInfos({
            expectSingles: new Set<number>(),
            inferredLayouts: wholePage.inferredLayouts,
        })).toMatchObject([{code: 'expectation-mismatch'}]);
        expect(buildExpectationInfos({
            expectSingles: new Set([1]),
            inferredLayouts: wholePage.inferredLayouts,
        })).toEqual([]);

        const splitPage = buildExpectedMapping(1, 2);
        expect(splitPage.entries).toEqual([
            {
                cleanedPage: 1,
                side: 'left',
                sourcePage: 1,
                sourceLayout: 'spread',
            },
            {
                cleanedPage: 2,
                side: 'right',
                sourcePage: 1,
                sourceLayout: 'spread',
            },
        ]);

        const partialSplit = buildExpectedMapping(10, 19);
        expect(partialSplit.expectedCleanedCount).toBe(20);
        expect(partialSplit.entries.at(-1)).toMatchObject({
            cleanedPage: 20,
            side: 'right',
            sourcePage: 10,
        });
    });

    it('aligns bounded placement shifts and rejects a no-overlap candidate', () => {
        const source = makeSyntheticBitmap();
        const shifted = alignBitmapForComparison(source, makeSyntheticBitmap(16));

        expect(shifted.metrics).toMatchObject({
            applied: true,
            bestOverlap: 1,
            rejected: false,
        });
        expect(shifted.metrics.bestSimilarity).toBeGreaterThan(0.8);
        expect(shifted.metrics.offsetPixels.x).toBeLessThan(0);
        expect(Math.abs(shifted.metrics.offsetPixels.x)).toBeLessThanOrEqual(24);
        expect(shifted.metrics.offsetPixels.y).toBe(0);

        const lost = alignBitmapForComparison(source, makeSyntheticBitmap(0, false));
        expect(lost.metrics).toMatchObject({
            applied: false,
            bestOverlap: 0,
            rejected: true,
        });
        expect(lost.metrics.appliedOffsetPixels).toEqual({
            x: 0,
            y: 0,
        });
    });

    it('flags output leaf-top drift beyond the source-half delta', () => {
        const sourceLeft = makeContentTopBitmap(32);
        const sourceRight = makeContentTopBitmap(34);
        const misaligned = measureSpreadLeafVerticalAlignment({
            cleanedLeft: makeContentTopBitmap(32),
            cleanedRight: makeContentTopBitmap(96),
            dpi: 50,
            sourceLeft,
            sourceRight,
        });
        expect(misaligned.status).toBe('violation');
        expect(misaligned.violations).toContain('leaf-misalignment');

        const aligned = measureSpreadLeafVerticalAlignment({
            cleanedLeft: makeContentTopBitmap(32),
            cleanedRight: makeContentTopBitmap(34),
            dpi: 50,
            sourceLeft,
            sourceRight,
        });
        expect(aligned.status).toBe('pass');
        expect(aligned.violations).toEqual([]);
    });

    it('flags a signed leaf-delta reversal with equal absolute magnitudes', () => {
        const reversed = measureSpreadLeafVerticalAlignment({
            cleanedLeft: makeContentTopBitmap(100),
            cleanedRight: makeContentTopBitmap(0),
            dpi: 50,
            sourceLeft: makeContentTopBitmap(0),
            sourceRight: makeContentTopBitmap(100),
        });

        expect(reversed.status).toBe('violation');
        expect(reversed.deltaDifferencePx).toBe(-200);
        expect(reversed.deltaExcessPx).toBe(200);
        expect(reversed.violations).toContain('leaf-misalignment');
    });

    it('flags a gross uniform vertical translation of both leaves', () => {
        const translated = measureSpreadLeafVerticalAlignment({
            cleanedLeft: makeContentTopBitmap(72),
            cleanedRight: makeContentTopBitmap(74),
            dpi: 50,
            sourceLeft: makeContentTopBitmap(24),
            sourceRight: makeContentTopBitmap(26),
        });

        expect(translated.deltaDifferencePx).toBe(0);
        expect(translated.absolutePosition.shiftFraction).toBeGreaterThan(0.15);
        expect(translated.status).toBe('violation');
        expect(translated.violations).toContain('leaf-misalignment');
    });

    it('anchors pale content before the dark-ink grid begins', () => {
        const sourceLeft = makeContentTopBitmap(32, 240);
        const sourceRight = makeContentTopBitmap(34, 240);
        const aligned = measureSpreadLeafVerticalAlignment({
            cleanedLeft: makeContentTopBitmap(32, 240),
            cleanedRight: makeContentTopBitmap(34, 240),
            dpi: 100,
            sourceLeft,
            sourceRight,
        });
        expect(aligned.status).toBe('pass');
        expect(aligned.source.leftTopPx).toBe(32);
        expect(aligned.cleaned.rightTopPx).toBe(34);
    });

    it('flags unequal source-relative leaf content scales and reports unmeasured pairs', () => {
        const sourceLeft = makeContentTopBitmap(32, 0, 80);
        const sourceRight = makeContentTopBitmap(34, 0, 80);
        const mismatch = measureSpreadLeafScale({
            cleanedLeft: makeContentTopBitmap(32, 0, 80),
            cleanedRight: makeContentTopBitmap(34, 0, 72),
            sourceLeft,
            sourceRight,
        });
        expect(mismatch.status).toBe('violation');
        expect(mismatch.violations).toContain('leaf-scale-mismatch');
        expect(mismatch.scales.left).toBe(1);
        expect(mismatch.scales.right).toBe(0.9);

        const unmeasured = measureSpreadLeafScale({
            cleanedLeft: makeContentTopBitmap(32, 0, 80),
            cleanedRight: makeContentTopBitmap(34, 0, 0),
            sourceLeft,
            sourceRight,
        });
        expect(unmeasured.status).toBe('unmeasured');
        expect(unmeasured.reason).toBe('content-span-not-measurable');
        expect(unmeasured.violations).toEqual([]);

        const incomparableSourceSpans = measureSpreadLeafScale({
            cleanedLeft: makeContentTopBitmap(32, 0, 80),
            cleanedRight: makeContentTopBitmap(34, 0, 72),
            sourceLeft,
            sourceRight: makeContentTopBitmap(34, 0, 60),
        });
        expect(incomparableSourceSpans.status).toBe('unmeasured');
        expect(incomparableSourceSpans.reason).toBe('source-content-spans-not-comparable');
        expect(incomparableSourceSpans.violations).toEqual([]);
    });

    it('flags synthetic facing-margin asymmetry and never passes an unmeasurable leaf', () => {
        const violation = measureFacingMarginAsymmetry({
            leftBitmap: makeHorizontalMarginBitmap(50, 5),
            rightBitmap: makeHorizontalMarginBitmap(20, 20),
        });
        expect(violation.status).toBe('violation');
        expect(violation.violations).toContain('facing-margin-asymmetry');
        expect(violation.left).toMatchObject({
            balanced: false,
            leftMarginPx: 50,
            rightMarginPx: 5,
        });
        expect(violation.right).toMatchObject({
            balanced: true,
            leftMarginPx: 20,
            rightMarginPx: 20,
        });

        const unmeasured = measureFacingMarginAsymmetry({
            leftBitmap: makeHorizontalMarginBitmap(20, 20),
            rightBitmap: makeSyntheticBitmap(0, false),
        });
        expect(unmeasured.status).toBe('unmeasured');
        expect(unmeasured.violations).toEqual([]);
    });

    it('flags local component loss and leaves sparse PNG bands unmeasured', async () => {
        const glyphs = Array.from({length: 24}, (_, index) => ({
            height: 6,
            width: 4,
            x: 4 + index * 5,
            y: 22,
        }));
        const source = await makePngBitmap({rectangles: glyphs});
        const cleaned = await makePngBitmap({rectangles: glyphs.slice(0, 12)});
        const loss = measureComponentSurvival({
            cleanedBitmap: cleaned,
            sourceBitmap: source,
        });

        expect(loss.status).toBe('violation');
        expect(loss.violations).toContain('component-survival');
        expect(loss.bands).toContainEqual(expect.objectContaining({
            cleanedComponents: 12,
            lossFraction: 0.3478,
            sourceComponents: 23,
            status: 'violation',
            survivingSourceComponents: 15,
        }));

        const sparseSource = await makePngBitmap({rectangles: glyphs.slice(0, 4)});
        const sparse = measureComponentSurvival({
            cleanedBitmap: sparseSource,
            sourceBitmap: sparseSource,
        });
        expect(sparse.status).toBe('unmeasured');
        expect(sparse.reason).toBe('insufficient-total-source-components');
        expect(sparse.unmeasuredBands).toBe(1);
        expect(sparse.violations).toEqual([]);
    });

    it('fails distinctly when any class exceeds the unmeasured-pair bound', () => {
        const measurements = Array.from({length: 10}, (_, index) => ({status: index < 4
            ? 'unmeasured'
            : 'pass'}));
        const coverage = summarizeMeasurementCoverage({
            'component-survival': measurements,
            'leaf-misalignment': [],
            'leaf-scale-mismatch': [
                {status: 'unmeasured'},
                {status: 'pass'},
            ],
        });

        expect(coverage.maxUnmeasuredFraction).toBe(0.3);
        expect(coverage.measurementCollapsed).toBe(true);
        expect(coverage.classes['component-survival']).toMatchObject({
            collapsed: true,
            status: 'measurement-collapse',
            totalPairs: 10,
            unmeasuredFraction: 0.4,
            unmeasuredPairs: 4,
        });
        expect(coverage.classes['leaf-misalignment'].status).toBe('not-applicable');
        expect(auditExitCode(0, coverage.measurementCollapsed)).toBe(2);
        expect(auditExitCode(1, false)).toBe(1);
    });
});
