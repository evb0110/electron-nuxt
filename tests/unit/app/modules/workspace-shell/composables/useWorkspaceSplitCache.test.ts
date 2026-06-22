import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

const stateStore = new Map<string, ReturnType<typeof ref>>();

function installUseStateStub() {
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

async function createSplitCache() {
    const { useWorkspaceSplitCache } = await import('@app/modules/workspace-shell/composables/useWorkspaceSplitCache');
    return useWorkspaceSplitCache();
}

describe('useWorkspaceSplitCache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    it('returns true for a fresh entry and consumes it once', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-1', {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            snapshotPath: '/tmp/pdf-work-test/sample.pdf',
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

    it('preserves DjVu paging state in cached split payloads', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-djvu', {
            kind: 'djvu',
            sourcePath: '/tmp/doc.djvu',
            currentPage: 12,
            totalPages: 40,
        });

        expect(splitCache.consume('tab-djvu')).toEqual({
            kind: 'djvu',
            sourcePath: '/tmp/doc.djvu',
            currentPage: 12,
            totalPages: 40,
        });
    });
});
