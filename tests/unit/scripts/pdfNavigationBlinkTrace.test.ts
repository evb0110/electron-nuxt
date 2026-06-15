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
            '--click-delay-ms',
            '0',
            '--pre-click-wait-ms',
            '0',
            '--skip-start-page-canvas-wait',
        ]);

        expect(options.video).toBe(true);
        expect(options.assert).toBe(true);
        expect(options.videoDir).toBe('.devkit/visual');
        expect(options.videoFps).toBe(12);
        expect(options.clicks).toBe(3);
        expect(options.clickDelayMs).toBe(0);
        expect(options.preClickWaitMs).toBe(0);
        expect(options.waitForStartCanvas).toBe(false);
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
        expect(summary.toolbarAheadOfBodySampleCount).toBe(1);
        expect(summary.postReadyUnstableSampleCount).toBe(2);
        expect(summary.latePostClickSwapCount).toBe(2);
        expect(summary.targetCanvasRegressionSampleCount).toBe(0);
    });

    it('measures target feedback geometry changes before the final canvas', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 5,
                    kind: 'after-next-click',
                }],
                samples: [
                    {
                        atMs: 100,
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            height: 300,
                            page: 2,
                            skeletonVisible: true,
                            visualReady: false,
                            width: 120,
                        }],
                    },
                    {
                        atMs: 150,
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            height: 280,
                            page: 2,
                            skeletonVisible: true,
                            visualReady: false,
                            width: 120,
                        }],
                    },
                    {
                        atMs: 200,
                        centeredVisualPage: 2,
                        toolbarSnapshot: { currentPage: 2 },
                        visiblePages: [{
                            hasUsableCanvas: true,
                            height: 300,
                            page: 2,
                            skeletonVisible: false,
                            visualReady: true,
                            width: 120,
                        }],
                    },
                ],
            },
            renderTrace: [{
                event: 'single-page-set-paged-target',
                payload: { targetPage: 2 },
            }],
        });

        expect(summary.targetFeedbackGeometrySampleCount).toBe(3);
        expect(summary.targetFeedbackHeightDeltaPx).toBe(20);
        expect(summary.targetFeedbackWidthDeltaPx).toBe(0);
        expect(summary.firstTargetFeedbackGeometryMismatchSample).toMatchObject({ atMs: 150 });
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

    it('prefers visible toolbar labels over stale exposed toolbar snapshots', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 25,
                    kind: 'after-next-click',
                }],
                samples: [{
                    atMs: 150,
                    bodySignature: '52rv--',
                    centeredVisualPage: 52,
                    toolbarSnapshot: { currentPage: 52 },
                    visibleCurrentPageLabels: [{ text: '53' }],
                    visiblePages: [{
                        hasUsableCanvas: true,
                        page: 52,
                        skeletonVisible: false,
                        visualReady: true,
                    }],
                }],
            },
            renderTrace: [{
                event: 'workspace-go-to-page',
                payload: {
                    targetPage: 53,
                    traceAtMs: 30,
                },
            }],
        });

        expect(summary.toolbarPages).toEqual([53]);
        expect(summary.toolbarAheadOfBodySampleCount).toBe(1);
        expect(summary.firstToolbarAheadOfBodySample).toMatchObject({
            toolbarSnapshot: { currentPage: 52 },
            visibleCurrentPageLabels: [{ text: '53' }],
        });
    });

    it('reads physical page numbers from visible toolbar secondary labels', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 25,
                    kind: 'after-next-click',
                }],
                samples: [{
                    atMs: 150,
                    bodySignature: '52rv--',
                    centeredVisualPage: 52,
                    toolbarSnapshot: { currentPage: 52 },
                    visibleCurrentPageLabels: [{
                        text: 'A-12',
                        secondaryText: '(53)',
                    }],
                    visiblePages: [{
                        hasUsableCanvas: true,
                        page: 52,
                        skeletonVisible: false,
                        visualReady: true,
                    }],
                }],
            },
            renderTrace: [{
                event: 'workspace-go-to-page',
                payload: {
                    targetPage: 53,
                    traceAtMs: 30,
                },
            }],
        });

        expect(summary.toolbarPages).toEqual([53]);
        expect(summary.toolbarAheadOfBodySampleCount).toBe(1);
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

    it('flags non-final target commits after the final request', () => {
        const samples = [{
            atMs: 250,
            bodySignature: '53rv--',
            centeredVisualPage: 53,
            visiblePages: [{
                hasUsableCanvas: true,
                page: 53,
                skeletonVisible: false,
                visualReady: true,
            }],
        }];

        const summary = summarizeTrace({
            trace: { samples },
            renderTrace: [
                {
                    event: 'workspace-go-to-page',
                    payload: {
                        targetPage: 52,
                        traceAtMs: 100,
                    },
                },
                {
                    event: 'workspace-go-to-page',
                    payload: {
                        targetPage: 53,
                        traceAtMs: 120,
                    },
                },
                {
                    event: 'single-page-paged-target-committed',
                    payload: {
                        targetPage: 52,
                        traceAtMs: 180,
                    },
                },
                {
                    event: 'workspace-viewer-current-page-update-accepted',
                    payload: {
                        page: 52,
                        traceAtMs: 190,
                    },
                },
            ],
        });

        expect(summary.finalTargetPage).toBe(53);
        expect(summary.finalRequestTraceAtMs).toBe(120);
        expect(summary.nonFinalPagedCommitAfterFinalRequestCount).toBe(1);
        expect(summary.firstNonFinalPagedCommitAfterFinalRequest).toMatchObject({ event: 'single-page-paged-target-committed' });
        expect(summary.nonFinalWorkspacePageAcceptAfterFinalRequestCount).toBe(1);
        expect(summary.firstNonFinalWorkspacePageAcceptAfterFinalRequest).toMatchObject({ event: 'workspace-viewer-current-page-update-accepted' });
    });

    it('measures intermediate visual pages that settle after the last click', () => {
        const summary = summarizeTrace({
            trace: {
                events: [{
                    atMs: 100,
                    kind: 'after-next-click',
                }],
                samples: [
                    {
                        atMs: 90,
                        bodySignature: '52rv--',
                        centeredVisualPage: 52,
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 52,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 190,
                        bodySignature: '52rv--',
                        centeredVisualPage: 52,
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 52,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 360,
                        bodySignature: '52rv--',
                        centeredVisualPage: 52,
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 52,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                    {
                        atMs: 430,
                        bodySignature: '53rv--',
                        centeredVisualPage: 53,
                        visiblePages: [{
                            hasUsableCanvas: true,
                            page: 53,
                            skeletonVisible: false,
                            visualReady: true,
                        }],
                    },
                ],
            },
            renderTrace: [{
                event: 'workspace-go-to-page',
                payload: {
                    targetPage: 53,
                    traceAtMs: 110,
                },
            }],
        });

        expect(summary.finalTargetPage).toBe(53);
        expect(summary.intermediateVisualAfterClickSampleCount).toBe(2);
        expect(summary.maxIntermediateVisualAfterClickRunMs).toBe(170);
        expect(summary.firstIntermediateVisualAfterClickSample).toMatchObject({
            atMs: 190,
            centeredVisualPage: 52,
        });
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
