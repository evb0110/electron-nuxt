import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    analyzeTraceFrames,
    readOptions,
    resolveVideoDirectory,
} from '@scripts/diagnostics/pdfNavigationBlinkTrace';

describe('pdf navigation blink trace options', () => {
    it('parses opt-in video capture flags', () => {
        const options = readOptions([
            '--video',
            '--video-dir',
            '.devkit/visual',
            '--video-fps',
            '12',
            '--clicks',
            '3',
        ]);

        expect(options.video).toBe(true);
        expect(options.videoDir).toBe('.devkit/visual');
        expect(options.videoFps).toBe(12);
        expect(options.clicks).toBe(3);
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
