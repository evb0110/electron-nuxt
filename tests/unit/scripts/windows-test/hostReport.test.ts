import {
    mkdir,
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IWindowsTestRunSummary } from '@scripts/windows-test/contracts/windowsTestContracts';
import { windowsTestRunLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    buildWindowsTestReport,
    formatWindowsTestRunSummary,
    isWindowsTestRunSummary,
    listWindowsTestRunIds,
    loadWindowsTestRunSummary,
} from '@scripts/windows-test/host/report';

const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';

function summary(overrides: Partial<IWindowsTestRunSummary> = {}): IWindowsTestRunSummary {
    return {
        schemaVersion: 1,
        runId: '20260904T120000Z-0123456789ab',
        suite: 'smoke',
        environment: 'win11-arm64',
        sourceSha: 'b'.repeat(40),
        artifactSha256: 'a'.repeat(64),
        artifactFileName: 'EVBViewer-Setup.exe',
        imageId: 'win11-arm64-2026-09',
        vmId: CLONE_VM_ID,
        runnerVersion: '2026-09-04.1',
        outcome: 'passed',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:00.000Z',
        endedAt: '2026-09-04T12:10:00.000Z',
        transitions: [{
            state: 'complete',
            elapsedMs: 600_000,
            reason: 'Run finished.',
        }],
        failures: [],
        expectedTests: ['WIN-SAVE-01'],
        executedTests: ['WIN-SAVE-01'],
        passedTests: ['WIN-SAVE-01'],
        failedTests: [],
        unsupportedTests: [],
        uncoveredObligations: ['WIN-PRINT-09'],
        humanReviewRequired: true,
        evidenceDirectory: '/tmp/runs/20260904T120000Z-0123456789ab/evidence',
        retainedClone: false,
        ...overrides,
    };
}

async function createRunsDir(summaries: readonly IWindowsTestRunSummary[]) {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'evb-windows-report-'));
    for (const entry of summaries) {
        const layout = windowsTestRunLayout(runsDir, entry.runId);
        await mkdir(layout.runDir, {recursive: true});
        await writeFile(layout.summaryFile, `${JSON.stringify(entry, null, 4)}\n`, 'utf8');
    }
    return runsDir;
}

describe('windows test run report', () => {
    it('loads the newest recorded run when no run ID is given', async () => {
        const runsDir = await createRunsDir([
            summary({runId: '20260901T090000Z-aaaaaaaaaaaa'}),
            summary({
                runId: '20260904T120000Z-0123456789ab',
                outcome: 'product-failed',
                exitCode: 2,
                passedTests: [],
                failedTests: ['WIN-SAVE-01'],
            }),
        ]);

        const report = await buildWindowsTestReport({
            runsDir,
            runId: null,
            json: false,
        });

        expect(report.exitCode).toBe(0);
        expect(report.summary?.runId).toBe('20260904T120000Z-0123456789ab');
        expect(report.lines.join('\n')).toContain('Failed cases: WIN-SAVE-01');
    });

    it('loads a specific immutable summary by run ID', async () => {
        const runsDir = await createRunsDir([
            summary({runId: '20260901T090000Z-aaaaaaaaaaaa'}),
            summary(),
        ]);

        const report = await buildWindowsTestReport({
            runsDir,
            runId: '20260901T090000Z-aaaaaaaaaaaa',
            json: false,
        });

        expect(report.summary?.runId).toBe('20260901T090000Z-aaaaaaaaaaaa');
        expect(await listWindowsTestRunIds(runsDir)).toEqual([
            '20260901T090000Z-aaaaaaaaaaaa',
            '20260904T120000Z-0123456789ab',
        ]);
    });

    it('prints uncovered obligations and the human review obligation on their own lines', () => {
        const lines = formatWindowsTestRunSummary(summary());

        expect(lines).toContain('Uncovered obligations (1): WIN-PRINT-09');
        expect(lines).toContain('Human review obligation: yes');
        expect(lines.some(line => line.startsWith('Passed 1,'))).toBe(true);
        expect(formatWindowsTestRunSummary(summary({
            uncoveredObligations: [],
            humanReviewRequired: false,
        }))).toEqual(expect.arrayContaining([
            'Uncovered obligations: none',
            'Human review obligation: no',
        ]));
    });

    it('emits the raw summary document in JSON mode', async () => {
        const runsDir = await createRunsDir([summary()]);

        const report = await buildWindowsTestReport({
            runsDir,
            runId: null,
            json: true,
        });

        expect(report.lines).toHaveLength(1);
        expect(JSON.parse(report.lines[0] ?? '')).toMatchObject({runId: '20260904T120000Z-0123456789ab'});
    });

    it('exits 1 for no runs, an unusable run ID and an unreadable summary', async () => {
        const emptyDir = await mkdtemp(path.join(tmpdir(), 'evb-windows-report-empty-'));
        const runsDir = await createRunsDir([summary()]);
        await writeFile(
            windowsTestRunLayout(runsDir, '20260904T120000Z-0123456789ab').summaryFile,
            '{ not json',
            'utf8',
        );

        expect((await buildWindowsTestReport({
            runsDir: emptyDir,
            runId: null,
            json: false,
        })).exitCode).toBe(1);
        expect((await buildWindowsTestReport({
            runsDir,
            runId: 'yesterday',
            json: false,
        })).lines.join('')).toContain('is not a Windows test run ID');
        expect((await buildWindowsTestReport({
            runsDir,
            runId: '20260904T120000Z-0123456789ab',
            json: false,
        })).exitCode).toBe(1);
        expect(await loadWindowsTestRunSummary(runsDir, '20260904T120000Z-0123456789ab')).toBeNull();
    });

    it('ignores directories that are not run IDs and summaries of the wrong shape', async () => {
        const runsDir = await createRunsDir([summary()]);
        await mkdir(path.join(runsDir, 'scratch'), {recursive: true});
        const strayLayout = windowsTestRunLayout(runsDir, '20260905T120000Z-ffffffffffff');
        await mkdir(strayLayout.runDir, {recursive: true});
        await writeFile(strayLayout.summaryFile, JSON.stringify({schemaVersion: 1}), 'utf8');

        expect(await listWindowsTestRunIds(runsDir)).toEqual([
            '20260904T120000Z-0123456789ab',
            '20260905T120000Z-ffffffffffff',
        ]);
        expect(await loadWindowsTestRunSummary(runsDir, '20260905T120000Z-ffffffffffff')).toBeNull();
    });

    it('rejects a stored summary that lacks a field the report prints', () => {
        expect(isWindowsTestRunSummary(summary())).toBe(true);
        expect(isWindowsTestRunSummary({
            ...summary(),
            passedTests: 'WIN-SAVE-01',
        })).toBe(false);
        expect(isWindowsTestRunSummary({
            ...summary(),
            evidenceDirectory: undefined,
        })).toBe(false);
        expect(isWindowsTestRunSummary({
            ...summary(),
            retainedClone: 'no',
        })).toBe(false);
    });
});
