import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildStressRunId,
    compareStressResultWithBaseline,
    computeStressRunTotals,
    createEmptyStressBaseline,
    readStressBaseline,
    renderStressSummaryMarkdown,
    resolveStressRunVerdict,
    stressBaselinePath,
    updateStressBaseline,
    writeStressBaseline,
    writeStressRunJson,
} from '@scripts/stress/stressReport';
import type {
    IStressMetricsSummary,
    IStressRun,
    IStressScenarioResult,
} from '@scripts/stress/stressTypes';

function metrics(overrides: Partial<IStressMetricsSummary> = {}): IStressMetricsSummary {
    return {
        sampleCount: 1,
        durationMs: 1000,
        peakRssBytes: 1000,
        peakRssPid: '1',
        peakJsHeapUsedBytes: 10,
        firstJsHeapUsedBytes: 10,
        lastJsHeapUsedBytes: 10,
        heartbeatMaxGapMs: 100,
        workerHeartbeatMaxGapMs: 100,
        longTaskCount: 0,
        longTaskP95Ms: 0,
        longTaskMaxMs: 0,
        frameGapP95Ms: 16,
        frameGapMaxMs: 16,
        droppedFrameRatio: 0,
        consoleErrors: [],
        pageErrors: [],
        rendererCrashed: false,
        crashReason: null,
        ...overrides,
    };
}

function result(overrides: Partial<IStressScenarioResult> = {}): IStressScenarioResult {
    return {
        id: 'open-xlarge',
        kind: 'deterministic',
        status: 'passed',
        startedAt: '2026-09-04T10:00:00.000Z',
        durationMs: 5000,
        profileId: 'baseline',
        findings: [],
        metrics: metrics(),
        steps: [{
            index: 1,
            step: {
                kind: 'open',
                fixture: 'text-small-12',
            },
            startedAt: '2026-09-04T10:00:00.000Z',
            durationMs: 1000,
            status: 'succeeded',
            error: null,
            detail: {},
        }],
        operator: null,
        artifacts: {},
        infraError: null,
        ...overrides,
    };
}

function run(scenarios: IStressScenarioResult[], finishedAt: string | null = '2026-09-04T11:00:00.000Z'): IStressRun {
    return {
        schemaVersion: 1,
        runId: 'r1',
        startedAt: '2026-09-04T10:00:00.000Z',
        finishedAt,
        gitSha: 'abcdef0123456789',
        hostProfile: 'baseline',
        platform: 'darwin-arm64',
        calibration: null,
        scenarios,
        totals: computeStressRunTotals(scenarios),
        verdict: 'incomplete',
    };
}

describe('stress run bookkeeping', () => {
    it('builds run ids from utc time, short sha and profile', () => {
        expect(buildStressRunId(new Date('2026-09-04T10:11:12Z'), 'abcdef0123456789', 'slow-a')).toBe('20260904-101112-abcdef01-slow-a');
    });

    it('counts statuses and operator spend', () => {
        const totals = computeStressRunTotals([
            result(),
            result({status: 'failed'}),
            result({status: 'infra-failed'}),
            result({status: 'skipped'}),
            result({operator: {
                model: 'claude-sonnet-5',
                operatorProfile: 'pixel',
                turns: 3,
                actions: 5,
                costUsd: 0.75,
                report: null,
                stopReason: 'report',
            }}),
        ]);
        expect(totals).toEqual({
            passed: 2,
            failed: 1,
            infraFailed: 1,
            skipped: 1,
            costUsd: 0.75,
        });
    });

    it('derives the verdict from completion and scenario statuses', () => {
        expect(resolveStressRunVerdict(run([result()], null))).toBe('incomplete');
        expect(resolveStressRunVerdict(run([result()]))).toBe('passed');
        expect(resolveStressRunVerdict(run([
            result(),
            result({status: 'skipped'}),
        ]))).toBe('passed');
        expect(resolveStressRunVerdict(run([result({status: 'infra-failed'})]))).toBe('failed');
    });

    it('renders a markdown summary with the verdict and one row per scenario', () => {
        const markdown = renderStressSummaryMarkdown({
            ...run([
                result(),
                result({
                    id: 'tab-storm',
                    status: 'failed',
                    findings: [{
                        severity: 'major',
                        oracle: 'peak-rss',
                        message: 'too much memory',
                    }],
                }),
            ]),
            verdict: 'failed',
        });
        expect(markdown).toContain('Verdict: **failed**');
        expect(markdown).toContain('open-xlarge');
        expect(markdown).toContain('tab-storm');
        expect(markdown).toContain('too much memory');
    });
});

describe('stress baseline comparison', () => {
    const baseline = updateStressBaseline(createEmptyStressBaseline('baseline'), run([result()]), new Date('2026-09-04T12:00:00Z'));

    it('records one baseline entry per passed scenario with relaxed ceilings', () => {
        const entry = baseline.scenarios['open-xlarge'];
        expect(entry).toBeDefined();
        expect(entry?.iterations).toBe(1);
        expect(entry?.durations.total?.p95).toBe(5000);
        expect(entry?.durations.total?.samples).toEqual([5000]);
        expect(entry?.durations['open:text-small-12']?.p95).toBe(1000);
        expect(entry?.hardCeilings.peakElectronRssBytes).toBe(1500);
        expect(entry?.responsiveness.heartbeatMaxGapMs).toBe(2000);
    });

    it('reports a missing entry as info only', () => {
        const findings = compareStressResultWithBaseline(baseline, result({id: 'unknown-scenario'}));
        expect(findings.map(finding => `${finding.severity}:${finding.oracle}`)).toEqual(['info:baseline-missing']);
    });

    it('needs both the percent and the absolute regression to fire', () => {
        expect(compareStressResultWithBaseline(baseline, result({durationMs: 5100}))).toEqual([]);
        const slow = compareStressResultWithBaseline(baseline, result({durationMs: 7000}));
        expect(slow.map(finding => `${finding.severity}:${finding.oracle}`)).toEqual(['major:baseline-regression']);
        expect(slow[0]?.message).toContain('total');
    });

    it('fires on any absolute regression when the baseline p95 is zero', () => {
        const zeroed = updateStressBaseline(createEmptyStressBaseline('baseline'), run([result({durationMs: 0})]));
        const findings = compareStressResultWithBaseline(zeroed, result({durationMs: 200}));
        expect(findings.map(finding => `${finding.severity}:${finding.oracle}`)).toEqual(['major:baseline-regression']);
        expect(findings[0]?.message).toContain('baseline p95 0ms');
        expect(compareStressResultWithBaseline(zeroed, result({durationMs: 100}))).toEqual([]);
    });

    it('records large improvements as info', () => {
        const findings = compareStressResultWithBaseline(baseline, result({durationMs: 2000}));
        expect(findings.map(finding => finding.oracle)).toEqual(['baseline-improvement']);
    });

    it('applies the hard RSS and heartbeat ceilings from the baseline entry', () => {
        const findings = compareStressResultWithBaseline(baseline, result({metrics: metrics({
            peakRssBytes: 1600,
            heartbeatMaxGapMs: 2500,
        })}));
        expect(findings.map(finding => finding.oracle)).toEqual([
            'baseline-rss-ceiling',
            'baseline-heartbeat',
        ]);
    });

    it('refuses to bless a run with failures and increments iterations otherwise', () => {
        expect(() => updateStressBaseline(baseline, run([result({status: 'failed'})]))).toThrow(/refusing to update baseline/u);
        const next = updateStressBaseline(baseline, run([
            result(),
            result({
                id: 'other',
                status: 'skipped',
            }),
        ]));
        expect(next.scenarios['open-xlarge']?.iterations).toBe(2);
        expect(next.scenarios.other).toBeUndefined();
    });

    it('keeps a sample history so p50 and p95 come from past runs rather than the last one', () => {
        const next = updateStressBaseline(baseline, run([result({durationMs: 7000})]));
        const total = next.scenarios['open-xlarge']?.durations.total;
        expect(total?.samples).toEqual([
            5000,
            7000,
        ]);
        expect(total?.p50).toBe(5000);
        expect(total?.p95).toBe(7000);
    });
});

describe('stress report files', () => {
    let dir = '';

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stress-report-test-'));
    });

    afterAll(async () => {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    });

    it('round-trips a baseline through disk and rejects foreign json', async () => {
        const path = stressBaselinePath('slow-a', dir);
        expect(path).toBe(join(dir, 'slow-a.json'));
        await writeStressBaseline(path, createEmptyStressBaseline('slow-a'));
        const restored = await readStressBaseline(path);
        expect(restored?.hostProfile).toBe('slow-a');
        await writeStressBaseline(join(dir, 'bad.json'), JSON.parse('{"schemaVersion":1,"hostProfile":"x"}') as never);
        expect(await readStressBaseline(join(dir, 'bad.json'))).toBeNull();
        expect(await readStressBaseline(join(dir, 'missing.json'))).toBeNull();
    });

    it('writes run.json atomically into the run directory', async () => {
        const path = await writeStressRunJson(join(dir, 'run-a'), run([result()]));
        expect(path).toBe(join(dir, 'run-a', 'run.json'));
        const parsed = JSON.parse(await readFile(path, 'utf8')) as IStressRun;
        expect(parsed.runId).toBe('r1');
        expect(parsed.scenarios).toHaveLength(1);
    });
});
