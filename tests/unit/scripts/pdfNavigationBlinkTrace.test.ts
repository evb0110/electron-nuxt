import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    analyzeTraceFrames,
    readOptions,
    resolveVideoDirectory,
    summarizeTrace,
} from '@scripts/diagnostics/pdfNavigationBlinkTrace';

describe('pdf navigation blink trace options', () => {
    it('parses opt-in video capture flags', () => {
        const options = readOptions([
            '--assert',
            '--video',
            '--video-dir',
            '.devkit/visual',
            '--video-fps',
            '12',
            '--clicks',
            '3',
        ]);

        expect(options.video).toBe(true);
        expect(options.assert).toBe(true);
        expect(options.videoDir).toBe('.devkit/visual');
        expect(options.videoFps).toBe(12);
        expect(options.clicks).toBe(3);
    });

    it('uses the checked-in rapid navigation fixture by default', () => {
        expect(readOptions([]).pdf).toContain('/.devkit/manual-pdf-fixtures/page-jump-source.pdf');
    });

    it('enables video when a video directory is provided', () => {
        const options = readOptions([
            '--video-dir',
            '.devkit/visual',
        ]);

        expect(options.video).toBe(true);
        expect(options.videoDir).toBe('.devkit/visual');
    });

    it('resolves the default video directory next to the JSON output', () => {
        expect(resolveVideoDirectory({
            out: '.devkit/pdf-navigation-blink-trace.json',
            videoDir: null,
        }, '/repo')).toBe('/repo/.devkit/pdf-navigation-blink-trace-video');

        expect(resolveVideoDirectory({
            out: '.devkit/pdf-navigation-blink-trace.json',
            videoDir: '.devkit/custom-video',
        }, '/repo')).toBe('/repo/.devkit/custom-video');
    });
});

describe('pdf navigation blink trace summary', () => {
    it('summarizes visual ownership and post-click instability', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 5,
                    kind: 'after-next-click',
                }],
                samples: [
                    {
                        atMs: 0,
                        bodySignature: '1rv--',
                        centeredVisualPage: 1,
                        toolbarSnapshot: { currentPage: 1 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 1,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 10,
                        bodySignature: '1rv--|2--s-',
                        centeredVisualPage: 1,
                        skeletonPages: [2],
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [
                            {
                                hasUsableCanvas: true,
                                page: 1,
                                skeletonVisible: false,
                                visualReady: true,
                            },
                            {
                                page: 2,
                                skeletonVisible: true,
                                visualReady: false,
                            },
                        ],
                    },
                    {
                        atMs: 30,
                        bodySignature: '2-vs-',
                        centeredVisualPage: 2,
                        skeletonPages: [2],
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 2,
                            skeletonVisible: true,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 200,
                        bodySignature: '2--s-',
                        centeredVisualPage: null,
                        elementAtCenter: { page: '2' },
                        skeletonPages: [2],
                        visiblePages: [{
                            page: 2,
                            skeletonVisible: true,
                            visualReady: false,
                        }],
                    },
                    {
                        atMs: 250,
                        blankVisiblePages: [],
                        bodySignature: '2rv--',
                        centeredVisualPage: 2,
                        skeletonPages: [],
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 2,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 350,
                        blankVisiblePages: [3],
                        bodySignature: '3----',
                        centeredVisualPage: null,
                        skeletonPages: [],
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            page: 3,
                            skeletonVisible: false,
                            visualReady: false,
                        }],
                    },
                ],
            },
            renderTrace: [{
                event: 'single-page-set-paged-target',
                payload: { targetPage: 2 },
            }],
        });

        expect(summary.finalTargetPage).toBe(2);
        expect(summary.lastClickAtMs).toBe(5);
        expect(summary.bodyVisualReadyAtMs).toBe(30);
        expect(summary.skeletonVisualOverlapSampleCount).toBe(1);
        expect(summary.skeletonAfterVisualSampleCount).toBe(1);
        expect(summary.toolbarAheadOfBodySampleCount).toBe(2);
        expect(summary.postReadyUnstableSampleCount).toBe(2);
        expect(summary.latePostClickSwapCount).toBe(2);
        expect(summary.targetCanvasRegressionSampleCount).toBe(0);
    });

    it('prefers the hit-tested visible page over buffered DOM-order geometry', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 5,
                    kind: 'after-next-click',
                }],
                samples: [
                    {
                        atMs: 0,
                        bodySignature: '21rv--',
                        centeredVisualPage: 21,
                        elementAtCenter: { page: '21' },
                        toolbarSnapshot: { currentPage: 21 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 21,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 150,
                        bodySignature: '20-v-b|21rv--',
                        centeredVisualPage: 20,
                        elementAtCenter: { page: '21' },
                        toolbarSnapshot: { currentPage: 21 },
                        visiblePages: [
                            {
                                buffered: true,
                                hasUsableCanvas: true,
                                page: 20,
                                skeletonVisible: false,
                                visualReady: true,
                            },
                            {
                                buffered: false,
                                hasUsableCanvas: true,
                                page: 21,
                                skeletonVisible: false,
                                visualReady: true,
                            },
                        ],
                    },
                ],
            },
            renderTrace: [{
                event: 'single-page-set-paged-target',
                payload: { targetPage: 21 },
            }],
        });

        expect(summary.postReadyUnstableSampleCount).toBe(0);
    });

    it('flags target canvas regressions after the centered page is ready', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 5,
                    kind: 'after-next-click',
                }],
                samples: [
                    {
                        atMs: 0,
                        bodySignature: '4rv--',
                        centeredVisualPage: 4,
                        toolbarSnapshot: { currentPage: 4 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 4,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 150,
                        bodySignature: '4-v--',
                        centeredVisualPage: 4,
                        toolbarSnapshot: { currentPage: 4 },
                        visiblePages: [{
                            hasUsableCanvas: false,
                            hasUsablePreview: true,
                            page: 4,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                ],
            },
            renderTrace: [{
                event: 'single-page-set-paged-target',
                payload: { targetPage: 4 },
            }],
        });

        expect(summary.bodyCanvasReadyAtMs).toBe(0);
        expect(summary.targetCanvasRegressionSampleCount).toBe(1);
        expect(summary.firstTargetCanvasRegressionSample).toMatchObject({ atMs: 150 });
    });
});

describe('pdf navigation blink trace frame analysis', () => {
    it('flags skeleton samples that appear after canvas observation', () => {
        const summary = analyzeTraceFrames([
            {
                atMs: 1,
                canvasPages: [],
                skeletonPages: [1],
            },
            {
                atMs: 10,
                canvasPages: [2],
                skeletonPages: [2],
            },
            {
                atMs: 22,
                canvasPages: [],
                skeletonPages: [
                    3,
                    'ignored',
                ],
            },
        ]);

        expect(summary).toEqual({
            canvasObservedAtMs: 10,
            firstSkeletonAfterCanvasAtMs: 22,
            skeletonAfterCanvasObserved: true,
            skeletonAfterCanvasPages: [3],
        });
    });

    it('does not treat pre-canvas skeleton samples as skeleton-after-canvas', () => {
        const summary = analyzeTraceFrames([
            {
                atMs: 1,
                canvasPages: [],
                skeletonPages: [1],
            },
            {
                atMs: 10,
                canvasPages: [2],
                skeletonPages: [2],
            },
        ]);

        expect(summary.skeletonAfterCanvasObserved).toBe(false);
        expect(summary.firstSkeletonAfterCanvasAtMs).toBeNull();
        expect(summary.skeletonAfterCanvasPages).toEqual([]);
    });
});
