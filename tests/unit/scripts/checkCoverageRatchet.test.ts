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
}) {
    const total = {
        statements: {
            total: 100,
            covered: metrics.statements,
            skipped: 0,
            pct: metrics.statements,
        },
        branches: {
            total: 100,
            covered: metrics.branches,
            skipped: 0,
            pct: metrics.branches,
        },
        functions: {
            total: 100,
            covered: metrics.functions,
            skipped: 0,
            pct: metrics.functions,
        },
        lines: {
            total: 100,
            covered: metrics.lines,
            skipped: 0,
            pct: metrics.lines,
        },
    };

    return JSON.stringify({ total });
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
                status: 'within-tolerance',
            }),
            expect.objectContaining({
                deltaPercentagePoints: 1,
                metric: 'functions',
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
            status: 'regressed',
        }));
        expect(formatCoverageRatchetResult(result)).toContain('Coverage ratchet failed.');
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
