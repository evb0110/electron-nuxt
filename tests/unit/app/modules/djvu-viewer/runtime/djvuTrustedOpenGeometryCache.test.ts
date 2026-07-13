import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IDjvuPageSourceInfo } from '@contracts/electronApiDjvu';
import {
    prewarmRecentDjvuOpeningGeometry,
    readPrevalidatedTrustedDjvuOpenGeometry,
} from '@app/modules/djvu-viewer/runtime/djvuTrustedOpenGeometryCache';

describe('DjVu trusted opening geometry cache', () => {
    it('makes exact Recent geometry synchronously available before the click transaction', async () => {
        const readStat = vi.fn().mockRejectedValue(new Error('generic file stat is not authorized yet'));
        const readSourceInfo = vi.fn().mockResolvedValue({
            pageCount: 431,
            pageNumber: 1,
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: 42,
        });

        await prewarmRecentDjvuOpeningGeometry([{
            fileName: 'scan.djvu',
            originalPath: '/docs/scan.djvu',
            timestamp: Date.now(),
        }], {
            readStat,
            readSourceInfo,
        });

        expect(readPrevalidatedTrustedDjvuOpenGeometry('/docs/scan.djvu', 1)).toEqual({
            documentId: '/docs/scan.djvu',
            pageNumber: 1,
            pageCount: 431,
            width: 600,
            height: 800,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 42,
        });
        expect(readStat).not.toHaveBeenCalled();
        expect(readSourceInfo).toHaveBeenCalledTimes(1);
    });

    it('fails a stalled Recent probe open without blocking a ready sibling', async () => {
        const stalledPath = '/docs/stalled.djvu';
        const readyPath = '/docs/ready.djvu';
        const settled = new Map<string, boolean>();
        const results = await prewarmRecentDjvuOpeningGeometry([
            {
                fileName: 'stalled.djvu',
                originalPath: stalledPath,
                timestamp: 2,
            },
            {
                fileName: 'ready.djvu',
                originalPath: readyPath,
                timestamp: 1,
            },
        ], {
            readStat: vi.fn().mockResolvedValue({
                size: 1_000,
                modifiedAt: 2_000,
            }),
            readSourceInfo: vi.fn((path: string): Promise<IDjvuPageSourceInfo> => path === stalledPath
                ? new Promise<IDjvuPageSourceInfo>(() => undefined)
                : Promise.resolve({
                    pageCount: 2,
                    pageNumber: 1,
                    pageSize: {
                        width: 600,
                        height: 800,
                        dpi: 300,
                    },
                })),
        }, {
            concurrency: 2,
            settleTimeoutMs: 20,
            onSettled: (file, geometry) => settled.set(file.originalPath, geometry !== null),
        });

        expect(results.get(stalledPath)).toBeNull();
        expect(results.get(readyPath)).not.toBeNull();
        expect(settled).toEqual(new Map([
            [
                readyPath,
                true,
            ],
            [
                stalledPath,
                false,
            ],
        ]));
    });

    it('does not stack more native probes behind timed-out worker slots', async () => {
        const files = Array.from({length: 4}, (_, index) => ({
            originalPath: `/docs/permanently-stalled-${String(index + 1)}.djvu`,
            fileName: `permanently-stalled-${String(index + 1)}.djvu`,
            timestamp: 4 - index,
        }));
        const readSourceInfo = vi.fn(() => new Promise<IDjvuPageSourceInfo>(() => undefined));

        const results = await prewarmRecentDjvuOpeningGeometry(files, {readSourceInfo}, {
            concurrency: 2,
            settleTimeoutMs: 5,
        });

        expect(readSourceInfo).toHaveBeenCalledTimes(2);
        expect([...results.entries()]).toEqual(files.slice(0, 2).map(file => [
            file.originalPath,
            null,
        ]));
    });
});
