import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    compareCoverageToBaseline,
    createCoverageBaseline,
    DEFAULT_COVERAGE_AREAS,
    LOAD_BEARING_COVERAGE_FILES,
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
        ...Object.fromEntries(LOAD_BEARING_COVERAGE_FILES.map(filePath => [
            `/repo/${filePath}`,
            metricSummary(filePct),
        ])),
        '/repo/app/runtime.ts': metricSummary(filePct),
        '/repo/electron/main.ts': metricSummary(filePct),
        '/repo/electron/features/djvu/open.ts': metricSummary(filePct),
        '/repo/electron/ocr/recognize.ts': metricSummary(filePct),
        '/repo/app/modules/pdf-viewer/viewer.ts': metricSummary(filePct),
        '/repo/app/modules/workspace-shell/workspace.ts': metricSummary(filePct),
        '/repo/scan-cleanup-adapters/renderers.ts': metricSummary(filePct),
        '/repo/scan-cleanup-core/detection.ts': metricSummary(filePct),
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
            'scan-cleanup-adapters': {include: ['scan-cleanup-adapters/']},
            'scan-cleanup-core': {include: ['scan-cleanup-core/']},
            'scripts-core': {include: ['scripts/']},
            'workspace-shell': {include: ['app/modules/workspace-shell/']},
        });
    });

    it('ratchets lifecycle-critical files and rejects zero execution', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 0,
            pct: 0,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} has zero executed lines`);
    });

    it('detects a load-bearing file regression hidden by stable aggregate coverage', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 79.49,
            pct: 79.49,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} lines regressed by 0.51 percentage points`);
    });

    it('rejects a coverage denominator shrink while source files remain on disk', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            baselineSnapshot.files.map(file => file.filePath),
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(
            'app-core coverage file count shrank from 6 to 5 while 6 source files remain on disk',
        );
    });

    it('allows a stored denominator to shrink only with the on-disk source set', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            snapshot.files.map(file => file.filePath),
        );

        expect(result.failures).not.toContain(
            'app-core coverage file count shrank from 6 to 5',
        );
    });
});
