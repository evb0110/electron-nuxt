import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionRetention,
} from '@scan-cleanup-core/detection';
import type {IScanCleanupDetectionRequest} from '@contracts/electronApiScanCleanup';

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        force: true,
        recursive: true,
    })));
});

describe('runScanCleanupDetection non-stream raster admission', () => {
    it('rejects a Windows-style whole-document staging footprint before rendering', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const pageCount = 30;
        const renderPage = vi.fn();
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => pageCount),
            pageSizes: vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                // 3,000 × 3,000 at 150 DPI: plausible individually, but the
                // non-stream document total cannot fit the cache budget.
                widthPoints: 1_440,
                heightPoints: 1_440,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        const request: IScanCleanupDetectionRequest = {
            ownerId: 'owner',
            sourcePdfPath: '/tmp/input.pdf',
            documentRevision: 'revision',
            options: {
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'auto',
                readingOrder: 'ltr',
                thickness: 0,
                crop: true,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
                skipBlankPages: false,
                pageOverrides: {},
            },
        };

        await expect(runScanCleanupDetection(
            request,
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                // The fallback branch is selected by omitting createRasterPipes.
                getAvailableScratchBytes: vi.fn(async () => 1),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(),
            },
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toThrow('raster cache/scratch budget');

        expect(renderPage).not.toHaveBeenCalled();
        expect(retention.retain).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
    });
});
