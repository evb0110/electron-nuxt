import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

async function createSplitCache() {
    const { useWorkspaceSplitCache } = await import('@app/composables/useWorkspaceSplitCache');
    return useWorkspaceSplitCache();
}

describe('useWorkspaceSplitCache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
    });

    it('returns true for a fresh entry and consumes it once', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-1', {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
            isDirty: false,
            currentPage: 7,
        });

        expect(splitCache.has('tab-1')).toBe(true);
        expect(splitCache.consume('tab-1')).toEqual(expect.objectContaining({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            currentPage: 7,
        }));
        expect(splitCache.has('tab-1')).toBe(false);
    });

    it('treats expired entries as missing from has()', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-expired', {
            kind: 'djvu',
            sourcePath: '/tmp/doc.djvu',
        });

        vi.advanceTimersByTime(2 * 60 * 1000 + 1);

        expect(splitCache.has('tab-expired')).toBe(false);
        expect(splitCache.consume('tab-expired')).toBeNull();
    });
});
