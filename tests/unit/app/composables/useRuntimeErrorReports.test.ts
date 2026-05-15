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

async function createReports() {
    const { useRuntimeErrorReports } = await import('@app/composables/useRuntimeErrorReports');
    return useRuntimeErrorReports();
}

describe('useRuntimeErrorReports', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    it('deduplicates by explicit key and keeps the latest detail', async () => {
        const reports = await createReports();

        reports.reportRuntimeError({
            title: 'Application warning',
            source: 'open-path-capabilities',
            error: '2026-01-01T00:00:00.000Z\n[WARN] rejected path',
            dedupeKey: 'open-path-capabilities\n[WARN] rejected path',
        });
        reports.reportRuntimeError({
            title: 'Application warning',
            source: 'open-path-capabilities',
            error: '2026-01-01T00:00:01.000Z\n[WARN] rejected path',
            dedupeKey: 'open-path-capabilities\n[WARN] rejected path',
        });

        expect(reports.reports.value).toHaveLength(1);
        expect(reports.reports.value[0]).toMatchObject({
            count: 2,
            detail: '2026-01-01T00:00:01.000Z\n[WARN] rejected path',
        });
    });

    it('dismisses one report without clearing the rest', async () => {
        const reports = await createReports();

        reports.reportRuntimeError({
            title: 'First',
            source: 'test',
            error: 'one',
        });
        reports.reportRuntimeError({
            title: 'Second',
            source: 'test',
            error: 'two',
        });
        reports.dismissRuntimeErrorReport('test\nSecond\ntwo');

        expect(reports.reports.value.map(report => report.title)).toEqual(['First']);
    });
});
