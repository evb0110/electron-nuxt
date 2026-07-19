import {readFileSync} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupPreviewMetadata} from '@contracts/electronApiScanCleanup';
import {
    resolvePreviewCanvasSize,
    resolvePreviewPlacement,
    toPreviewStyleRect,
    transformPreviewContentBox,
} from '@app/modules/scan-cleanup/utils/scanCleanupPreviewGeometry';

function metadata(overrides: Partial<IScanCleanupPreviewMetadata> = {}): IScanCleanupPreviewMetadata {
    return {
        half: 'full',
        layoutClassification: 'single-uncut-page',
        sourceRegion: {
            x: 100,
            y: 20,
            width: 400,
            height: 600,
        },
        contentBox: {
            x: 10,
            y: 30,
            width: 200,
            height: 300,
        },
        appliedMargins: [
            15,
            15,
            15,
            15,
        ],
        outputWidth: 230,
        outputHeight: 330,
        forwardTransform: {matrix: [
            [
                1,
                0,
                -100,
            ],
            [
                0,
                1,
                -20,
            ],
            [
                0,
                0,
                1,
            ],
        ]},
        warnings: [],
        ...overrides,
    };
}

describe('scan cleanup preview geometry', () => {
    it('maps the half-local detected content box through the source-to-output affine', () => {
        expect(transformPreviewContentBox(metadata())).toEqual({
            x: 10,
            y: 30,
            width: 200,
            height: 300,
        });
    });

    it('uses both spread halves to approximate a shared canvas and honors placement', () => {
        const left = metadata({
            half: 'left',
            outputWidth: 210,
            outputHeight: 300,
        });
        const right = metadata({
            half: 'right',
            outputWidth: 230,
            outputHeight: 330,
        });
        const canvas = resolvePreviewCanvasSize([
            left,
            right,
        ], true);
        expect(canvas).toEqual({
            width: 230,
            height: 330,
        });

        expect(resolvePreviewPlacement(210, 300, 230, 330, 'top-center')).toMatchObject({
            left: 10,
            top: 0,
        });
        const bottomRight = resolvePreviewPlacement(210, 300, 230, 330, 'bottom-right');
        expect(bottomRight).toMatchObject({
            left: 20,
            top: 30,
        });
        expect(toPreviewStyleRect({
            x: 0,
            y: 0,
            width: 210,
            height: 300,
        }, bottomRight)).toEqual({
            left: `${20 / 230 * 100}%`,
            top: `${30 / 330 * 100}%`,
            width: `${210 / 230 * 100}%`,
            height: `${300 / 330 * 100}%`,
        });
    });

    it('keeps comparison, spread rendering, cancellation, debounce, and cleaned-cache wiring in the dialog', () => {
        const pane = readFileSync('app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue', 'utf8');
        const popup = readFileSync('app/modules/scan-cleanup/components/ScanCleanupPopup.vue', 'utf8');

        expect(pane).toContain('v-if="showBefore"');
        expect(pane).toContain('v-for="(output, index) in renderedOutputs"');
        expect(pane).toContain('transformPreviewContentBox(metadata)');
        expect(popup).toContain('const previewCache = new Map');
        expect(popup).toContain('cancelPreview(sourcePath)');
        expect(popup).toContain('}, 250);');
        expect(popup).toContain('sequence !== previewSequence');
    });
});
