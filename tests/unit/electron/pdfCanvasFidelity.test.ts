import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { renderPdfCanvasFidelityMetrics } from '@tests/helpers/renderPdfCanvasFidelityMetrics';

const fixtures = [
    {
        file: 'generated-text.pdf',
        expected: {
            dark: {
                default: 0.00380,
                linux: 0.00322,
            },
            ink: {
                default: 0.01138,
                linux: 0.01082,
            },
            luminance: {
                default: {
                    max: 253.997,
                    min: 253.897,
                },
                linux: {
                    max: 254.116,
                    min: 254.016,
                },
            },
            textItems: 6,
        },
    },
    {
        file: 'freetext-lifecycle-test.pdf',
        expected: {
            dark: {
                default: 0.00383,
                linux: 0.00332,
            },
            ink: {
                default: 0.00728,
                linux: 0.00613,
            },
            luminance: {
                default: {
                    max: 254.011,
                    min: 253.911,
                },
                // GitHub's Ubuntu runners have produced both 254.053779 and
                // 254.134063 for this annotation-heavy fixture with identical
                // source and dependency revisions. Ink and dark-pixel ratios
                // remain tightly asserted above; this narrow band permits only
                // the backend's antialiasing variation.
                linux: {
                    max: 254.17,
                    min: 254.02,
                },
            },
            textItems: 3,
        },
    },
    {
        file: 'test-scanned.pdf',
        expected: {
            dark: {
                default: 0.01040,
                linux: 0.01040,
            },
            ink: {
                default: 0.01284,
                linux: 0.01284,
            },
            luminance: {
                default: {
                    max: 252.259,
                    min: 252.159,
                },
                linux: {
                    max: 252.259,
                    min: 252.159,
                },
            },
            textItems: 0,
        },
    },
] as const;

describe('PDF canvas fidelity corpus', () => {
    for (const fixture of fixtures) {
        it(`renders ${fixture.file} at its matched physical scale`, async () => {
            const metrics = await renderPdfCanvasFidelityMetrics(resolve(
                process.cwd(),
                'tests/fixtures/electron',
                fixture.file,
            ));

            expect(metrics.width).toBe(612);
            expect(metrics.height).toBe(792);
            expect(metrics.textItemCount).toBe(fixture.expected.textItems);
            // Text glyph rasterization differs between the macOS and Linux
            // canvas backends. Keep a tight baseline for each observed backend
            // instead of widening the assertion enough to hide real regressions.
            const expectedInk = process.platform === 'linux'
                ? fixture.expected.ink.linux
                : fixture.expected.ink.default;
            expect(metrics.inkPixelRatio).toBeCloseTo(expectedInk, 3);
            const expectedDark = process.platform === 'linux'
                ? fixture.expected.dark.linux
                : fixture.expected.dark.default;
            expect(metrics.darkPixelRatio).toBeCloseTo(expectedDark, 3);
            const expectedLuminanceRange = process.platform === 'linux'
                ? fixture.expected.luminance.linux
                : fixture.expected.luminance.default;
            expect(metrics.meanLuminance).toBeGreaterThanOrEqual(expectedLuminanceRange.min);
            expect(metrics.meanLuminance).toBeLessThanOrEqual(expectedLuminanceRange.max);
        });
    }
});
