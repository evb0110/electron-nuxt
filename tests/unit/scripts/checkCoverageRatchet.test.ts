import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    compareCoverageToBaseline,
    createCoverageBaseline,
    DEFAULT_COVERAGE_AREAS,
    parseCoverageSummary,
} from '@scripts/checkCoverageRatchet';

function metricSummary(pct: number) {
    return Object.fromEntries([
        'statements',
        'branches',
        'functions',
        'lines',
    ].map(metric => [
        metric,
        {
            covered: pct,
            pct,
            skipped: 0,
            total: 100,
        },
    ]));
}

function summary(totalPct: number, filePct = totalPct) {
    return JSON.stringify({
        total: metricSummary(totalPct),
        '/repo/app/runtime.ts': metricSummary(filePct),
        '/repo/electron/main.ts': metricSummary(filePct),
        '/repo/electron/features/djvu/open.ts': metricSummary(filePct),
        '/repo/electron/ocr/recognize.ts': metricSummary(filePct),
        '/repo/app/modules/pdf-viewer/viewer.ts': metricSummary(filePct),
        '/repo/app/modules/workspace-shell/workspace.ts': metricSummary(filePct),
        '/repo/scripts/release/build.ts': metricSummary(filePct),
    });
}

describe('coverage ratchet', () => {
    it('detects broad regressions beyond the configured tolerance', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70), '/repo'));
        const result = compareCoverageToBaseline(
            parseCoverageSummary(summary(69.49), '/repo'),
            baseline,
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('total lines regressed by 0.51 percentage points');
    });

    it('detects a per-area regression even when total coverage is stable', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 79), '/repo');
        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('electron-core lines regressed by 1.00 percentage points');
    });

    it('tracks major application and release areas', () => {
        expect(DEFAULT_COVERAGE_AREAS).toMatchObject({
            'app-core': {include: ['app/']},
            'electron-core': {include: ['electron/']},
            'pdf-viewer': {include: ['app/modules/pdf-viewer/']},
            'release-scripts': {include: ['scripts/release/']},
            'scripts-core': {include: ['scripts/']},
            'workspace-shell': {include: ['app/modules/workspace-shell/']},
        });
    });
});
