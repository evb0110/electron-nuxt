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
                default: 253.947,
                linux: 254.066,
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
                default: 253.961,
                linux: 254.134,
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
                default: 252.209,
                linux: 252.209,
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
            const expectedLuminance = process.platform === 'linux'
                ? fixture.expected.luminance.linux
                : fixture.expected.luminance.default;
            expect(metrics.meanLuminance).toBeCloseTo(expectedLuminance, 1);
        });
    }
});
