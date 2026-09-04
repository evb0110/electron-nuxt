import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    evaluateStressOracles,
    isStressFailure,
    parseMacOSCrashReport,
    sortStressFindings,
} from '@scripts/stress/stressOracles';
import type { IStressOracleInput } from '@scripts/stress/stressOracles';
import { DEFAULT_STRESS_THRESHOLDS } from '@scripts/stress/stressScenarioRegistry';
import type {
    IStressMetricsSummary,
    IStressStepRecord,
} from '@scripts/stress/stressTypes';

function metrics(overrides: Partial<IStressMetricsSummary> = {}): IStressMetricsSummary {
    return {
        sampleCount: 10,
        durationMs: 10_000,
        peakRssBytes: 500 * 1024 * 1024,
        peakRssPid: '1',
        peakJsHeapUsedBytes: 100,
        firstJsHeapUsedBytes: 100,
        lastJsHeapUsedBytes: 120,
        heartbeatMaxGapMs: 50,
        workerHeartbeatMaxGapMs: 50,
        longTaskCount: 0,
        longTaskP95Ms: 0,
        longTaskMaxMs: 0,
        frameGapP95Ms: 16,
        frameGapMaxMs: 40,
        droppedFrameRatio: 0,
        consoleErrors: [],
        pageErrors: [],
        rendererCrashed: false,
        crashReason: null,
        ...overrides,
    };
}

function step(overrides: Partial<IStressStepRecord> = {}): IStressStepRecord {
    return {
        index: 1,
        step: {
            kind: 'goToPage',
            pages: [2],
        },
        startedAt: '2026-09-04T00:00:00.000Z',
        durationMs: 100,
        status: 'succeeded',
        error: null,
        detail: {},
        ...overrides,
    };
}

function input(overrides: Partial<IStressOracleInput> = {}): IStressOracleInput {
    return {
        thresholds: DEFAULT_STRESS_THRESHOLDS,
        metrics: metrics(),
        steps: [step()],
        finalAppState: null,
        integrity: [],
        leakedPids: [],
        leakedWorkDirs: [],
        crashReports: [],
        frozenScreenshotStreak: 0,
        ...overrides,
    };
}

function oracles(findings: ReturnType<typeof evaluateStressOracles>) {
    return findings.map(finding => `${finding.severity}:${finding.oracle}`);
}

describe('evaluateStressOracles', () => {
    it('returns no findings for a clean scenario', () => {
        expect(evaluateStressOracles(input())).toEqual([]);
    });

    it('treats a renderer crash and a macOS crash report as critical', () => {
        const findings = evaluateStressOracles(input({
            metrics: metrics({
                rendererCrashed: true,
                crashReason: 'Target crashed',
            }),
            crashReports: [{
                path: '/tmp/Electron.ips',
                processName: 'Electron',
                terminationNamespace: 'SIGNAL',
                terminationCode: '11',
                exceptionType: 'EXC_BAD_ACCESS',
            }],
        }));
        expect(oracles(findings)).toEqual([
            'critical:renderer-crash',
            'critical:macos-crash-report',
        ]);
        expect(isStressFailure(findings)).toBe(true);
    });

    it('escalates a main-thread stall past five times the limit to critical', () => {
        const limit = DEFAULT_STRESS_THRESHOLDS.heartbeatMaxGapMs;
        expect(oracles(evaluateStressOracles(input({metrics: metrics({heartbeatMaxGapMs: limit + 1})})))).toEqual(['major:main-thread-unresponsive']);
        expect(oracles(evaluateStressOracles(input({metrics: metrics({heartbeatMaxGapMs: limit * 5 + 1})})))).toEqual(['critical:main-thread-unresponsive']);
    });

    it('keeps long-task and frame-gap misses minor so they do not fail the run alone', () => {
        const findings = evaluateStressOracles(input({metrics: metrics({
            longTaskP95Ms: DEFAULT_STRESS_THRESHOLDS.longTaskP95Ms + 1,
            frameGapP95Ms: DEFAULT_STRESS_THRESHOLDS.frameGapP95Ms + 1,
        })}));
        expect(oracles(findings)).toEqual([
            'minor:long-task-p95',
            'minor:frame-gap-p95',
        ]);
        expect(isStressFailure(findings)).toBe(false);
    });

    it('flags memory ceilings and heap growth as major', () => {
        const findings = evaluateStressOracles(input({metrics: metrics({
            peakRssBytes: DEFAULT_STRESS_THRESHOLDS.peakRssBytes + 1,
            firstJsHeapUsedBytes: 0,
            lastJsHeapUsedBytes: DEFAULT_STRESS_THRESHOLDS.jsHeapGrowthBytes + 1,
        })}));
        expect(oracles(findings)).toEqual([
            'major:peak-rss',
            'major:js-heap-growth',
        ]);
    });

    it('turns failed and slow steps into findings with the step index', () => {
        const findings = evaluateStressOracles(input({steps: [
            step({
                index: 3,
                status: 'failed',
                error: 'timed out',
            }),
            step({
                index: 4,
                durationMs: DEFAULT_STRESS_THRESHOLDS.stepDurationMaxMs + 1,
            }),
            step({
                index: 5,
                status: 'skipped',
            }),
        ]}));
        expect(oracles(findings)).toEqual([
            'major:step-failed',
            'minor:step-slow',
        ]);
        expect(findings[0]?.message).toContain('step 3');
        expect(findings[1]?.message).toContain('step 4');
    });

    it('reports integrity, leak, freeze and dialog oracles', () => {
        const findings = evaluateStressOracles(input({
            integrity: [
                {
                    path: '/tmp/a.pdf',
                    status: 'passed',
                    detail: '',
                },
                {
                    path: '/tmp/b.pdf',
                    status: 'failed',
                    detail: 'xref broken',
                },
                {
                    path: '/tmp/c.pdf',
                    status: 'skipped',
                    detail: 'qpdf not installed',
                },
            ],
            leakedPids: [
                123,
                456,
            ],
            leakedWorkDirs: ['/tmp/pdf-work-1'],
            frozenScreenshotStreak: 5,
            finalAppState: {
                tabIds: ['t1'],
                activeTabId: 't1',
                fileName: 'a.pdf',
                currentPage: 1,
                totalPages: 2,
                zoomPercent: 100,
                viewMode: 'single',
                activeTool: null,
                isDirty: false,
                isOpeningDocument: false,
                hasOpenError: false,
                readiness: 'ready',
                viewerInteractionReady: true,
                visibleDialogs: ['Unsaved changes'],
                visibleToasts: [],
            },
        }));
        expect(oracles(findings)).toEqual([
            'critical:saved-file-integrity',
            'critical:ui-frozen',
            'major:leaked-process',
            'minor:leaked-working-copy',
            'minor:dialog-left-open',
            'info:saved-file-integrity-skipped',
        ]);
        expect(findings.find(finding => finding.oracle === 'ui-frozen')?.message).toContain('5 identical screenshots in a row');
    });

    it('flags a freeze streak at the threshold as major and two above it as critical', () => {
        expect(oracles(evaluateStressOracles(input({frozenScreenshotStreak: 2})))).toEqual([]);
        expect(oracles(evaluateStressOracles(input({frozenScreenshotStreak: 3})))).toEqual(['major:ui-frozen']);
        expect(oracles(evaluateStressOracles(input({frozenScreenshotStreak: 5})))).toEqual(['critical:ui-frozen']);
    });

    it('sorts by severity while keeping insertion order inside a severity', () => {
        const sorted = sortStressFindings([
            {
                severity: 'info',
                oracle: 'a',
                message: '',
            },
            {
                severity: 'critical',
                oracle: 'b',
                message: '',
            },
            {
                severity: 'minor',
                oracle: 'c',
                message: '',
            },
            {
                severity: 'critical',
                oracle: 'd',
                message: '',
            },
        ]);
        expect(sorted.map(finding => finding.oracle)).toEqual([
            'b',
            'd',
            'c',
            'a',
        ]);
    });
});

describe('parseMacOSCrashReport', () => {
    it('reads the process name, termination and exception from the JSON body', () => {
        const raw = `${JSON.stringify({app_name: 'Electron'})}\n${JSON.stringify({
            procName: 'Electron Helper (Renderer)',
            termination: {
                namespace: 'SIGNAL',
                code: 11,
            },
            exception: {type: 'EXC_BAD_ACCESS'},
        })}`;
        expect(parseMacOSCrashReport('/tmp/r.ips', raw)).toEqual({
            path: '/tmp/r.ips',
            processName: 'Electron Helper (Renderer)',
            terminationNamespace: 'SIGNAL',
            terminationCode: '11',
            exceptionType: 'EXC_BAD_ACCESS',
        });
    });

    it('keeps the path when the body is truncated', () => {
        const report = parseMacOSCrashReport('/tmp/r.ips', '{"app_name":"Electron"}\n{"procName": ');
        expect(report.path).toBe('/tmp/r.ips');
        expect(report.processName).toBeNull();
    });
});
