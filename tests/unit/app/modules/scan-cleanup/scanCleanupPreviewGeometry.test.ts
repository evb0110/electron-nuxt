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
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
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
        cutterX: null,
        inputWidth: 600,
        inputHeight: 640,
        rotation: 0,
        resamplePasses: 1,
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

    it('round-trips a rotated manual cutter through preview coordinates', () => {
        const analysisWidth = scanCleanupAnalysisWidth({rotation: 90}, 1200, 800);
        expect(analysisWidth).toBe(800);
        const sourceX = 317;
        const ratio = scanCleanupCutterRatio(sourceX, analysisWidth);
        expect(scanCleanupCutterXFromRatio(ratio, analysisWidth)).toBeCloseTo(sourceX, 8);
    });

    it('keeps comparison, spread rendering, cancellation, debounce, and cleaned-cache wiring in the dialog', () => {
        const pane = readFileSync('app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue', 'utf8');
        const dialog = readFileSync('app/modules/scan-cleanup/components/ScanCleanupDialog.vue', 'utf8');
        const tokens = readFileSync('app/assets/css/main.css', 'utf8');

        expect(pane).toContain('effectiveViewMode === \'original\'');
        expect(pane).toContain('@keydown.left.prevent');
        expect(pane).toContain('effectiveZoomMode === \'actual\'');
        expect(pane).toContain('v-for="(output, index) in renderedOutputs"');
        expect(pane).toContain('transformPreviewContentBox(metadata)');
        expect(dialog).toContain('const previewCache = new Map');
        expect(dialog).toContain('cancelPreview(sourcePath)');
        expect(dialog).toContain('}, 250);');
        expect(dialog).toContain('sequence !== previewSequence');
        expect(dialog.match(/scan-cleanup-dialog-shell/gu)).toHaveLength(1);
        expect(dialog).not.toContain('@click="isOpen = true"');
        expect(dialog).not.toContain('state === \'complete\'');
        expect(dialog).not.toContain('savePdfDialog');
        expect(tokens).toContain('--app-scan-dialog-width: 90vw');
        expect(tokens).toContain('--app-scan-dialog-height: 85vh');
    });
});
