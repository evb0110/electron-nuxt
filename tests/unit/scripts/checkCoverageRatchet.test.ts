import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    compareCoverageToBaseline,
    createCoverageBaseline,
    DEFAULT_COVERAGE_AREAS,
    formatCoverageRatchetResult,
    parseCoverageSummary,
    runCoverageRatchet,
    stringifyCoverageBaseline,
} from '@scripts/checkCoverageRatchet';

const tempDirs: string[] = [];

function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'evb-coverage-ratchet-'));
    tempDirs.push(dir);
    return dir;
}

function coverageSummary(metrics: {
    branches: number;
    functions: number;
    lines: number;
    statements: number;
}, files: Record<string, {
    branches: number;
    functions: number;
    lines: number;
    statements: number;
}> = {}) {
    const metricSummary = (nextMetrics: {
        branches: number;
        functions: number;
        lines: number;
        statements: number;
    }) => ({
        statements: {
            total: 100,
            covered: nextMetrics.statements,
            skipped: 0,
            pct: nextMetrics.statements,
        },
        branches: {
            total: 100,
            covered: nextMetrics.branches,
            skipped: 0,
            pct: nextMetrics.branches,
        },
        functions: {
            total: 100,
            covered: nextMetrics.functions,
            skipped: 0,
            pct: nextMetrics.functions,
        },
        lines: {
            total: 100,
            covered: nextMetrics.lines,
            skipped: 0,
            pct: nextMetrics.lines,
        },
    });

    return JSON.stringify({
        total: metricSummary(metrics),
        ...Object.fromEntries(Object.entries(files).map(([
            filePath,
            fileMetrics,
        ]) => [
            filePath,
            metricSummary(fileMetrics),
        ])),
    });
}

describe('coverage ratchet', () => {
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, {
                force: true,
                recursive: true,
            });
        }
    });

    it('passes regressions inside the tolerance and reports improvements', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(coverageSummary({
            branches: 50,
            functions: 60,
            lines: 70,
            statements: 80,
        })));
        const snapshot = parseCoverageSummary(coverageSummary({
            branches: 49.6,
            functions: 61,
            lines: 70,
            statements: 79.5,
        }));

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(true);
        expect(result.comparisons).toEqual(expect.arrayContaining([
            expect.objectContaining({
                deltaPercentagePoints: -0.4,
                metric: 'branches',
                scope: 'total',
                status: 'within-tolerance',
            }),
            expect.objectContaining({
                deltaPercentagePoints: 1,
                metric: 'functions',
                scope: 'total',
                status: 'improved',
            }),
        ]));
        expect(formatCoverageRatchetResult(result)).toContain('Coverage ratchet passed.');
    });

    it('fails only when a metric regresses beyond the tolerance', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(coverageSummary({
            branches: 50,
            functions: 60,
            lines: 70,
            statements: 80,
        })));
        const snapshot = parseCoverageSummary(coverageSummary({
            branches: 49.49,
            functions: 60,
            lines: 70,
            statements: 80,
        }));

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.comparisons).toContainEqual(expect.objectContaining({
            deltaPercentagePoints: -0.51,
            metric: 'branches',
            scope: 'total',
            status: 'regressed',
        }));
        expect(formatCoverageRatchetResult(result)).toContain('Coverage ratchet failed.');
    });

    it('ratchets configured hot-path area aggregates independently of the global total', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(coverageSummary({
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70,
        }, {'/repo/app/modules/pdf-viewer/runtime/navigation/controller.ts': {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
        }}), '/repo'), 0.5, {'pdf-viewer-navigation': {include: ['app/modules/pdf-viewer/runtime/navigation/']}});
        const snapshot = parseCoverageSummary(coverageSummary({
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70,
        }, {'/repo/app/modules/pdf-viewer/runtime/navigation/controller.ts': {
            branches: 80,
            functions: 80,
            lines: 79.4,
            statements: 80,
        }}), '/repo');

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.comparisons).toContainEqual(expect.objectContaining({
            area: 'pdf-viewer-navigation',
            deltaPercentagePoints: -0.6,
            metric: 'lines',
            scope: 'area',
            status: 'regressed',
        }));
        expect(formatCoverageRatchetResult(result)).toContain('pdf-viewer-navigation lines');
    });

    it('requires area ratchets for release, OCR, DjVu, and updater hot paths', () => {
        expect(DEFAULT_COVERAGE_AREAS).toMatchObject({
            'electron-djvu-feature': {include: ['electron/features/djvu/']},
            'electron-ocr': {include: ['electron/ocr/']},
            'electron-updates': {include: ['electron/updates']},
            'release-scripts': {include: ['scripts/release/']},
        });
    });

    it('updates the baseline deterministically from a generated summary', async () => {
        const cwd = createTempDir();
        const coverageDir = join(cwd, 'coverage');
        mkdirSync(coverageDir);
        writeFileSync(join(coverageDir, 'coverage-summary.json'), coverageSummary({
            branches: 43.21,
            functions: 65.43,
            lines: 76.54,
            statements: 87.65,
        }));

        const result = await runCoverageRatchet(['--update-baseline'], cwd);

        expect(result.passed).toBe(true);
        expect(await readFile(join(cwd, 'coverage-baseline.json'), 'utf8')).toBe(stringifyCoverageBaseline({
            metrics: {
                branches: 43.21,
                functions: 65.43,
                lines: 76.54,
                statements: 87.65,
            },
            tolerancePercentagePoints: 0.5,
            version: 1,
        }));
    });
});
