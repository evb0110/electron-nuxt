import {readFileSync} from 'node:fs';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupPreviewMetadata} from '@contracts/electronApiScanCleanup';
import {
    resolvePreviewCanvasSize,
    resolvePreviewFitPlacement,
    resolvePreviewOutputFitSizes,
    resolvePreviewOutputFitRects,
    resolvePreviewPlacement,
    resolvePreviewSpreadCutterCenter,
    resolveCutterControlGeometry,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    toPreviewStyleRect,
    transformPreviewContentBox,
} from '@app/modules/scan-cleanup/utils/scanCleanupPreviewGeometry';
import {createScanCleanupPreviewPrefetcher} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';

function metadata(overrides: Partial<IScanCleanupPreviewMetadata> = {}): IScanCleanupPreviewMetadata {
    return {
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
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

    it('maps a source cutter into the fitted source image instead of the full stage', () => {
        const placement = resolvePreviewFitPlacement(800, 600, 1200, 1800);
        expect(placement).toEqual({
            width: 400,
            height: 600,
            left: 200,
            top: 0,
        });
        expect(placement.left + placement.width * scanCleanupCutterRatio(600, 1200)).toBe(400);
    });

    it.each([
        {
            label: 'narrow',
            areas: [
                {
                    width: 180,
                    height: 520,
                },
                {
                    width: 180,
                    height: 520,
                },
            ],
        },
        {
            label: 'wide',
            areas: [
                {
                    width: 620,
                    height: 340,
                },
                {
                    width: 620,
                    height: 340,
                },
            ],
        },
    ])('preserves the exact canvas ratio in a $label editor', ({areas}) => {
        const canvases = [
            {
                width: 500,
                height: 800,
            },
            {
                width: 500,
                height: 800,
            },
        ];
        const rendered = resolvePreviewOutputFitSizes(areas, canvases);
        expect(rendered).toHaveLength(2);
        expect(rendered[0]!.width / rendered[0]!.height).toBe(500 / 800);
        expect(rendered[1]).toEqual(rendered[0]);
    });

    it('centers both the cutter line and grab handle on the requested coordinate', () => {
        const geometry = resolveCutterControlGeometry(417, 36, 2);
        expect(geometry.controlLeft).toBe(399);
        expect(geometry.handleCenter).toBe(417);
        expect(geometry.lineCenter).toBe(417);
    });

    it('places a symmetric spread cutter at the exact rendered-box gap center', () => {
        const areas = [
            {
                left: 0,
                top: 0,
                width: 390,
                height: 600,
            },
            {
                left: 410,
                top: 0,
                width: 390,
                height: 600,
            },
        ];
        const canvases = [
            {
                width: 500,
                height: 800,
            },
            {
                width: 500,
                height: 800,
            },
        ];
        const renderedBoxes = resolvePreviewOutputFitRects(areas, canvases);

        expect(renderedBoxes).toEqual([
            {
                left: 7.5,
                top: 0,
                width: 375,
                height: 600,
            },
            {
                left: 417.5,
                top: 0,
                width: 375,
                height: 600,
            },
        ]);
        expect(resolvePreviewSpreadCutterCenter(renderedBoxes)).toBe(400);
    });

    it('supersedes an in-flight adjacent prefetch when user navigation takes priority', async () => {
        const prefetchResult = Promise.withResolvers<{pageNumber: number}>();
        const preview = vi.fn((request: {pageNumber: number}) => request.pageNumber === 2
            ? prefetchResult.promise
            : Promise.resolve({pageNumber: request.pageNumber}));
        const store = vi.fn();
        const prefetcher = createScanCleanupPreviewPrefetcher({
            isCached: () => false,
            preview,
            store,
        });
        prefetcher.schedule([
            {
                key: 'page-2',
                request: {pageNumber: 2},
            },
            {
                key: 'page-3',
                request: {pageNumber: 3},
            },
        ]);
        expect(preview).toHaveBeenCalledTimes(1);

        prefetcher.supersede();
        await preview({pageNumber: 3});
        prefetchResult.resolve({pageNumber: 2});
        await prefetchResult.promise;
        await Promise.resolve();

        expect(preview).toHaveBeenCalledTimes(2);
        expect(store).not.toHaveBeenCalled();
    });

    it('keeps comparison, spread rendering, cancellation, debounce, and cleaned-cache wiring in the workspace', () => {
        const pane = readFileSync('app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue', 'utf8');
        const workspace = readFileSync('app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue', 'utf8');
        const session = readFileSync('app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession.ts', 'utf8');
        const tokens = readFileSync('app/assets/css/main.css', 'utf8');

        expect(pane).toContain('effectiveViewMode === \'original\'');
        expect(pane).toContain('@keydown.left.prevent');
        expect(pane).toContain('effectiveZoomMode === \'actual\'');
        expect(pane).toContain('cursor: col-resize');
        expect(pane).toContain('<Transition name="scan-preview-crossfade">');
        expect(pane).toContain('.content-overlay:focus-within .content-handle::after');
        expect(pane).not.toMatch(/\.content-handle\.is-n::after,[\s\S]*?display: none;/u);
        expect(pane).toContain('v-for="(output, index) in renderedOutputs"');
        expect(pane).toContain('transformPreviewContentBox(metadata)');
        expect(pane.match(/<ScanCleanupSegmented/gu)).toHaveLength(2);
        expect(workspace.match(/<ScanCleanupSegmented/gu)).toHaveLength(1);
        expect(session).toContain('const previewCache = new Map');
        expect(session).toContain('capability.cancelPreview(sourcePath.value)');
        expect(session).toContain('}, immediate ? 0 : 250);');
        expect(session).toContain('sequence !== previewSequence');
        expect(session).not.toContain('options.active() || isRunning.value');
        expect(workspace).toContain('@update:manual-split-x="updateCurrentManualSplit"');
        expect(session).toContain('manualSplitX: value');
        expect(workspace).not.toContain('UModal');
        expect(workspace).not.toContain('scan-cleanup-progress-overlay');
        expect(tokens).toContain('--app-scan-dialog-rail-width');
        expect(tokens).toContain('--app-scan-preview-crossfade-duration');
    });
});
