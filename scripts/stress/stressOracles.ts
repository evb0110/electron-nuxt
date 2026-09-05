import { execFile } from 'node:child_process';
import {
    readFile,
    readdir,
    stat,
} from 'node:fs/promises';
import {
    homedir,
    tmpdir,
} from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    findPidsByCommandSubstring,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import { FREEZE_STREAK_THRESHOLD } from '@scripts/stress/stressOperatorConversation';
import type {
    IStressAppState,
    IStressFinding,
    IStressIntegrityCheck,
    IStressMetricsSummary,
    IStressStepRecord,
    IStressThresholds,
} from '@scripts/stress/stressTypes';
import { stringifyJson } from '@contracts/stringifyJson';

const execFileAsync = promisify(execFile);
/** `qpdf --check` on a multi-GiB working copy is slow but finite; a hang is a finding, not a stuck run. */
const QPDF_TIMEOUT_MS = 5 * 60_000;

export interface IStressOracleInput {
    thresholds: IStressThresholds;
    metrics: IStressMetricsSummary | null;
    steps: IStressStepRecord[];
    finalAppState: IStressAppState | null;
    integrity: IStressIntegrityCheck[];
    leakedPids: number[];
    leakedWorkDirs: string[];
    crashReports: IMacOSCrashReport[];
    frozenScreenshotStreak: number;
}

export interface IMacOSCrashReport {
    path: string;
    processName: string | null;
    terminationNamespace: string | null;
    terminationCode: string | null;
    exceptionType: string | null;
}

/**
 * Pure: every threshold and hard ceiling becomes a finding here so a unit
 * test can pin the policy. Severity order drives the summary sort.
 */
export function evaluateStressOracles(input: IStressOracleInput): IStressFinding[] {
    const findings: IStressFinding[] = [];
    const {
        thresholds,
        metrics,
    } = input;

    if (metrics?.rendererCrashed) {
        findings.push({
            severity: 'critical',
            oracle: 'renderer-crash',
            message: `renderer crashed: ${metrics.crashReason ?? 'unknown reason'}`,
        });
    }
    for (const report of input.crashReports) {
        findings.push({
            severity: 'critical',
            oracle: 'macos-crash-report',
            message: `${report.processName ?? 'Electron'} crash report: ${report.terminationNamespace ?? '?'}/${report.terminationCode ?? '?'} ${report.exceptionType ?? ''}`.trim(),
            evidence: {path: report.path},
        });
    }
    if (metrics && metrics.pageErrors.length > 0) {
        findings.push({
            severity: 'major',
            oracle: 'page-error',
            message: `${metrics.pageErrors.length} uncaught renderer exception(s); first: ${metrics.pageErrors[0] ?? '<missing>'}`,
            evidence: {pageErrors: metrics.pageErrors.slice(0, 10)},
        });
    }
    if (metrics && metrics.consoleErrors.length > 0) {
        findings.push({
            severity: 'minor',
            oracle: 'console-error',
            message: `${metrics.consoleErrors.length} console error(s) outside the allowlist; first: ${metrics.consoleErrors[0] ?? '<missing>'}`,
            evidence: {consoleErrors: metrics.consoleErrors.slice(0, 10)},
        });
    }
    if (metrics && metrics.heartbeatMaxGapMs > thresholds.heartbeatMaxGapMs) {
        findings.push({
            severity: metrics.heartbeatMaxGapMs > thresholds.heartbeatMaxGapMs * 5 ? 'critical' : 'major',
            oracle: 'main-thread-unresponsive',
            message: `main thread stalled for ${metrics.heartbeatMaxGapMs.toFixed(0)}ms (limit ${thresholds.heartbeatMaxGapMs}ms)`,
        });
    }
    if (metrics && metrics.longTaskP95Ms > thresholds.longTaskP95Ms) {
        findings.push({
            severity: 'minor',
            oracle: 'long-task-p95',
            message: `long task p95 ${metrics.longTaskP95Ms.toFixed(0)}ms exceeds ${thresholds.longTaskP95Ms}ms (${metrics.longTaskCount} long tasks)`,
        });
    }
    if (metrics && metrics.frameGapP95Ms > thresholds.frameGapP95Ms) {
        findings.push({
            severity: 'minor',
            oracle: 'frame-gap-p95',
            message: `rAF gap p95 ${metrics.frameGapP95Ms.toFixed(0)}ms exceeds ${thresholds.frameGapP95Ms}ms (dropped ratio ${(metrics.droppedFrameRatio * 100).toFixed(1)}%)`,
        });
    }
    if (metrics && metrics.peakRssBytes > thresholds.peakRssBytes) {
        findings.push({
            severity: 'major',
            oracle: 'peak-rss',
            message: `process tree peaked at ${(metrics.peakRssBytes / 1024 / 1024).toFixed(0)} MiB (limit ${(thresholds.peakRssBytes / 1024 / 1024).toFixed(0)} MiB, pid ${metrics.peakRssPid ?? '?'})`,
        });
    }
    if (metrics && metrics.firstJsHeapUsedBytes !== null && metrics.lastJsHeapUsedBytes !== null) {
        const growth = metrics.lastJsHeapUsedBytes - metrics.firstJsHeapUsedBytes;
        if (growth > thresholds.jsHeapGrowthBytes) {
            findings.push({
                severity: 'major',
                oracle: 'js-heap-growth',
                message: `renderer JS heap grew by ${(growth / 1024 / 1024).toFixed(0)} MiB across the scenario (limit ${(thresholds.jsHeapGrowthBytes / 1024 / 1024).toFixed(0)} MiB)`,
            });
        }
    }

    for (const step of input.steps) {
        if (step.status === 'failed') {
            findings.push({
                severity: 'major',
                oracle: 'step-failed',
                message: `step ${step.index} (${step.step.kind}) failed: ${step.error ?? 'unknown error'}`,
                evidence: {step: step.step},
            });
        } else if (step.status === 'succeeded' && step.durationMs > thresholds.stepDurationMaxMs) {
            findings.push({
                severity: 'minor',
                oracle: 'step-slow',
                message: `step ${step.index} (${step.step.kind}) took ${step.durationMs}ms (limit ${thresholds.stepDurationMaxMs}ms)`,
            });
        }
    }

    for (const check of input.integrity) {
        if (check.status === 'failed') {
            findings.push({
                severity: 'critical',
                oracle: 'saved-file-integrity',
                message: `qpdf rejected ${check.path}: ${check.detail}`,
            });
        } else if (check.status === 'skipped') {
            findings.push({
                severity: 'info',
                oracle: 'saved-file-integrity-skipped',
                message: `${check.path} not verified: ${check.detail}`,
            });
        }
    }
    if (input.leakedPids.length > 0) {
        findings.push({
            severity: 'major',
            oracle: 'leaked-process',
            message: `${input.leakedPids.length} process(es) from this session survived teardown: ${input.leakedPids.join(', ')}`,
        });
    }
    if (input.leakedWorkDirs.length > 0) {
        findings.push({
            severity: 'minor',
            oracle: 'leaked-working-copy',
            message: `${input.leakedWorkDirs.length} pdf-work-* temp dir(s) left behind`,
            evidence: {dirs: input.leakedWorkDirs.slice(0, 10)},
        });
    }
    if (input.frozenScreenshotStreak >= FREEZE_STREAK_THRESHOLD) {
        findings.push({
            severity: input.frozenScreenshotStreak >= FREEZE_STREAK_THRESHOLD + 2 ? 'critical' : 'major',
            oracle: 'ui-frozen',
            message: `${input.frozenScreenshotStreak} identical screenshots in a row after state-changing actions`,
        });
    }
    const state = input.finalAppState;
    if (state?.visibleDialogs.length) {
        findings.push({
            severity: 'minor',
            oracle: 'dialog-left-open',
            message: `dialog still visible at scenario end: ${state.visibleDialogs[0] ?? '<missing>'}`,
        });
    }

    return sortStressFindings(findings);
}

const SEVERITY_RANK = {
    critical: 0,
    major: 1,
    minor: 2,
    info: 3,
};

export function sortStressFindings(findings: readonly IStressFinding[]) {
    return [...findings].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}

export function isStressFailure(findings: readonly IStressFinding[]) {
    return findings.some(finding => finding.severity === 'critical' || finding.severity === 'major');
}

export async function runQpdfIntegrityCheck(path: string): Promise<IStressIntegrityCheck> {
    try {
        await execFileAsync('qpdf', [
            '--check',
            path,
        ], {
            maxBuffer: 8 * 1024 * 1024,
            timeout: QPDF_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        });
        return {
            path,
            status: 'passed',
            detail: 'qpdf --check passed',
        };
    } catch (error) {
        const failure = error as {
            code?: unknown;
            stderr?: string;
            stdout?: string;
            message?: string
        };
        if (failure.code === 'ENOENT') {
            return {
                path,
                status: 'skipped',
                detail: 'qpdf not installed; integrity check skipped',
            };
        }
        return {
            path,
            status: 'failed',
            detail: ([
                failure.stderr,
                failure.stdout,
                failure.message,
            ].find(text => typeof text === 'string' && text.trim().length > 0) ?? 'qpdf failed').trim().split('\n').slice(-3).join(' | '),
        };
    }
}

/**
 * Identity-verified zombie sweep: only processes whose command line contains
 * this session's user-data directory count, so other sessions' Electron
 * processes are never touched.
 */
export function sweepLeakedSessionProcesses(userDataDir: string) {
    return findPidsByCommandSubstring(userDataDir).filter(pid => pid !== process.pid && isProcessAlive(pid));
}

export async function listLeakedPdfWorkDirs(sinceEpochMs: number, tempRoot = tmpdir()) {
    try {
        const entries = await readdir(tempRoot, {withFileTypes: true});
        const leaked: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('pdf-work-')) {
                continue;
            }
            const fullPath = join(tempRoot, entry.name);
            try {
                const info = await stat(fullPath);
                if (info.mtimeMs >= sinceEpochMs) {
                    leaked.push(fullPath);
                }
            } catch {
                // Removed between readdir and stat: not leaked.
            }
        }
        return leaked;
    } catch {
        return [];
    }
}

/**
 * macOS `.ips` reports are two concatenated JSON documents: a one-line
 * header followed by the report body. Only reports newer than the scenario
 * start and named `Electron*` belong to this run.
 */
export function parseMacOSCrashReport(path: string, raw: string): IMacOSCrashReport {
    const newline = raw.indexOf('\n');
    const bodyText = newline >= 0 ? raw.slice(newline + 1) : '';
    let processName: string | null = null;
    let terminationNamespace: string | null = null;
    let terminationCode: string | null = null;
    let exceptionType: string | null = null;
    try {
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        processName = typeof body.procName === 'string' ? body.procName : null;
        const termination = body.termination as Record<string, unknown> | undefined;
        terminationNamespace = typeof termination?.namespace === 'string' ? termination.namespace : null;
        const rawTerminationCode = termination?.code;
        terminationCode = rawTerminationCode === undefined
            ? null
            : typeof rawTerminationCode === 'string'
                ? rawTerminationCode
                : stringifyJson(rawTerminationCode) ?? '<unserializable>';
        const exception = body.exception as Record<string, unknown> | undefined;
        exceptionType = typeof exception?.type === 'string' ? exception.type : null;
    } catch {
        // Header-only or truncated report; keep the path as evidence.
    }
    return {
        path,
        processName,
        terminationNamespace,
        terminationCode,
        exceptionType,
    };
}

export async function collectMacOSCrashReports(sinceEpochMs: number, reportsDir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')) {
    if (process.platform !== 'darwin') {
        return [];
    }
    try {
        const entries = await readdir(reportsDir);
        const reports: IMacOSCrashReport[] = [];
        for (const name of entries) {
            if (!name.startsWith('Electron') || !name.endsWith('.ips')) {
                continue;
            }
            const fullPath = join(reportsDir, name);
            try {
                const info = await stat(fullPath);
                if (info.mtimeMs < sinceEpochMs) {
                    continue;
                }
                reports.push(parseMacOSCrashReport(fullPath, await readFile(fullPath, 'utf8')));
            } catch {
                // Rotated or unreadable report: the remaining ones still count.
            }
        }
        return reports;
    } catch {
        return [];
    }
}
