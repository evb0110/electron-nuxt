import { getErrorMessage } from '@contracts/getErrorMessage';
import {spawn} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import os from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import { stringifyJson } from '@contracts/stringifyJson';

export interface IQuarantineSummary {
    failed: number;
    passed: number;
    pending: number;
    todo: number;
    total: number;
}

export interface IQuarantinePolicySummary {
    declared: number;
    reported: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

const QUARANTINE_COUNTER_KEYS = [
    'numFailedTests',
    'numPassedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTests',
] as const;

type TQuarantineCounterKey = typeof QUARANTINE_COUNTER_KEYS[number];

const COUNTER_TO_SUMMARY_KEY: Record<TQuarantineCounterKey, keyof IQuarantineSummary> = {
    numFailedTests: 'failed',
    numPassedTests: 'passed',
    numPendingTests: 'pending',
    numTodoTests: 'todo',
    numTotalTests: 'total',
};

function readCounters(report: Record<string, unknown>) {
    return Object.fromEntries(QUARANTINE_COUNTER_KEYS.map(key => {
        const value = report[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
            throw new Error(`invalid quarantine counter ${key}: ${stringifyJson(value) ?? '<invalid>'}`);
        }
        return [
            key,
            value as number | undefined,
        ];
    })) as Record<TQuarantineCounterKey, number | undefined>;
}

function countNestedAssertions(report: Record<string, unknown>) {
    const rawSuites = report.testResults;
    if (rawSuites === undefined) {
        throw new Error('Quarantine report must contain testResults assertions');
    }
    if (!Array.isArray(rawSuites)) {
        throw new Error('Quarantine report testResults must be an array');
    }
    const statuses = rawSuites.flatMap((rawSuite, suiteIndex) => {
        if (!isRecord(rawSuite)) {
            throw new Error(`Quarantine report suite ${suiteIndex} must be an object`);
        }
        const rawAssertions = rawSuite.assertionResults;
        if (rawAssertions === undefined) {
            throw new Error(`Quarantine report suite ${suiteIndex} must contain assertionResults`);
        }
        if (!Array.isArray(rawAssertions)) {
            throw new Error(`Quarantine report suite ${suiteIndex} assertionResults must be an array`);
        }
        return rawAssertions.map((rawAssertion, assertionIndex) => {
            if (!isRecord(rawAssertion) || typeof rawAssertion.status !== 'string') {
                throw new Error(
                    `Quarantine report assertion ${suiteIndex}:${assertionIndex} has no valid status`,
                );
            }
            if (![
                'failed',
                'passed',
                'pending',
                'skipped',
                'todo',
            ].includes(rawAssertion.status)) {
                throw new Error(
                    `Quarantine report assertion ${suiteIndex}:${assertionIndex} has unknown status `
                    + `'${rawAssertion.status}'`,
                );
            }
            return rawAssertion.status;
        });
    });
    return {
        failed: statuses.filter(status => status === 'failed').length,
        passed: statuses.filter(status => status === 'passed').length,
        pending: statuses.filter(status => status === 'pending' || status === 'skipped').length,
        todo: statuses.filter(status => status === 'todo').length,
        total: statuses.length,
    };
}

export function summarizeQuarantineReport(report: unknown): IQuarantineSummary {
    if (!isRecord(report)) {
        throw new Error('Quarantine JSON reporter output must be an object');
    }
    if (report.success !== undefined && typeof report.success !== 'boolean') {
        throw new Error(`Quarantine report success must be boolean: ${stringifyJson(report.success) ?? '<invalid>'}`);
    }
    const counters = readCounters(report);
    const nested = countNestedAssertions(report);
    if (nested.total === 0) {
        throw new Error('empty quarantine assertions cannot be admitted');
    }
    for (const key of QUARANTINE_COUNTER_KEYS) {
        const topLevel = counters[key];
        const nestedKey = COUNTER_TO_SUMMARY_KEY[key];
        if (topLevel !== undefined && topLevel !== nested[nestedKey]) {
            throw new Error(
                `Quarantine report counter mismatch for ${key}: `
                + `top-level ${topLevel}, nested ${nested[nestedKey]}`,
            );
        }
    }
    return nested;
}

export function assertQuarantineReport(report: unknown): IQuarantineSummary {
    if (isRecord(report) && report.success === false) {
        throw new Error('Electron quarantine reporter marked the run as failed');
    }
    const summary = summarizeQuarantineReport(report);
    if (summary.total === 0) {
        throw new Error('Electron quarantine run collected zero tests');
    }
    if (summary.failed > 0) {
        throw new Error(`Electron quarantine run has ${summary.failed} failed tests`);
    }
    if (summary.pending > 0 || summary.todo > 0) {
        throw new Error(
            `Electron quarantine run has skipped or pending tests (pending=${summary.pending}, todo=${summary.todo})`,
        );
    }
    if (summary.passed !== summary.total) {
        throw new Error(
            `Electron quarantine run did not execute every test (passed=${summary.passed}, total=${summary.total})`,
        );
    }
    return summary;
}

function normalizeReportPath(path: string) {
    return path.replaceAll('\\', '/');
}

function readQuarantineReportSuiteNames(report: Record<string, unknown>) {
    const rawSuites = report.testResults;
    if (!Array.isArray(rawSuites)) {
        throw new Error('Quarantine report must contain testResults assertions');
    }
    return rawSuites.map((rawSuite, suiteIndex) => {
        if (!isRecord(rawSuite) || typeof rawSuite.name !== 'string' || rawSuite.name.trim() === '') {
            throw new Error(`Quarantine report suite ${suiteIndex} has no concrete name`);
        }
        return normalizeReportPath(rawSuite.name.trim());
    });
}

export function assertQuarantinePolicy(
    policy: unknown,
    report: unknown,
    now = new Date(),
): IQuarantinePolicySummary {
    if (!isRecord(policy) || !Array.isArray(policy.tests)) {
        throw new Error('Electron quarantine policy must contain a tests array');
    }
    if (!isRecord(report)) {
        throw new Error('Quarantine JSON reporter output must be an object');
    }
    if (Number.isNaN(now.getTime())) {
        throw new Error('Quarantine policy evaluation date is invalid');
    }
    const today = now.toISOString().slice(0, 10);
    const declaredReports = new Set<string>();
    for (const [
        index,
        rawEntry,
    ] of policy.tests.entries()) {
        if (!isRecord(rawEntry)) {
            throw new Error(`Quarantine policy entry ${index} must be an object`);
        }
        const path = typeof rawEntry.path === 'string' ? normalizeReportPath(rawEntry.path.trim()) : '';
        const issue = typeof rawEntry.issue === 'string' ? rawEntry.issue.trim() : '';
        const expiresOn = typeof rawEntry.expiresOn === 'string' ? rawEntry.expiresOn.trim() : '';
        const assertionReport = typeof rawEntry.assertionReport === 'string'
            ? normalizeReportPath(rawEntry.assertionReport.trim())
            : '';
        if (!path.startsWith('tests/e2e/electron/quarantine/') || !path.endsWith('.e2e.test.ts')) {
            throw new Error(`Quarantine policy entry ${index} has an invalid path`);
        }
        if (!/^(?:#\d+|https:\/\/github\.com\/evb0110\/evb-viewer\/issues\/\d+)$/u.test(issue)) {
            throw new Error(`Quarantine policy entry ${path} must name its GitHub issue`);
        }
        const parsedExpiry = new Date(`${expiresOn}T00:00:00.000Z`);
        if (
            !/^\d{4}-\d{2}-\d{2}$/u.test(expiresOn)
            || Number.isNaN(parsedExpiry.getTime())
            || parsedExpiry.toISOString().slice(0, 10) !== expiresOn
        ) {
            throw new Error(`Quarantine policy entry ${path} must name an expiry date`);
        }
        if (expiresOn < today) {
            throw new Error(`Quarantine policy entry ${path} expired on ${expiresOn}`);
        }
        if (assertionReport !== path) {
            throw new Error(
                `Quarantine policy entry ${path} must name its concrete assertion report suite`,
            );
        }
        if (declaredReports.has(assertionReport)) {
            throw new Error(`Quarantine assertion report is declared more than once: ${assertionReport}`);
        }
        declaredReports.add(assertionReport);
    }

    const reportedSuites = readQuarantineReportSuiteNames(report);
    const matchedReports = new Set<string>();
    for (const suiteName of reportedSuites) {
        const matches = [...declaredReports].filter(declared => (
            suiteName === declared || suiteName.endsWith(`/${declared}`)
        ));
        if (matches.length !== 1) {
            throw new Error(`Quarantine report suite is unreferenced by live policy: ${suiteName}`);
        }
        if (matchedReports.has(matches[0]!)) {
            throw new Error(`Quarantine assertion report suite appeared more than once: ${suiteName}`);
        }
        matchedReports.add(matches[0]!);
    }
    const missing = [...declaredReports].filter(declared => !matchedReports.has(declared));
    if (missing.length > 0) {
        throw new Error(`Quarantine policy entry has no concrete assertion report: ${missing.join(', ')}`);
    }
    return {
        declared: declaredReports.size,
        reported: reportedSuites.length,
    };
}

type TSpawn = typeof spawn;

export async function runElectronQuarantine({
    cwd = process.cwd(),
    policyPath = 'tests/e2e/electron/quarantine/graduation-policy.json',
    runner = 'scripts/test-electron-e2e-headless.sh',
    spawnImpl = spawn,
}: {
    cwd?: string;
    policyPath?: string;
    runner?: string;
    spawnImpl?: TSpawn;
} = {}) {
    const reportRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'evb-quarantine-'));
    const reportPath = join(reportRoot, 'vitest-report.json');
    const args = [
        runner,
        '--no-build',
        'e2e-quarantine',
        '--reporter',
        'json',
        `--outputFile.json=${reportPath}`,
    ];
    try {
        const exitCode = await new Promise<number>((resolvePromise, reject) => {
            const child = spawnImpl('bash', args, {
                cwd,
                env: process.env,
                stdio: 'inherit',
            });
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                if (signal) {
                    resolvePromise(1);
                    return;
                }
                resolvePromise(code ?? 1);
            });
        });
        if (exitCode !== 0) {
            throw new Error(`Electron quarantine runner exited with status ${exitCode}`);
        }
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
        const summary = assertQuarantineReport(report);
        const policy = JSON.parse(await readFile(resolve(cwd, policyPath), 'utf8')) as unknown;
        const policySummary = assertQuarantinePolicy(policy, report);
        process.stdout.write(`Electron quarantine passed: ${JSON.stringify({
            policy: policySummary,
            tests: summary,
        })}\n`);
        return summary;
    } finally {
        await rm(reportRoot, {
            force: true,
            recursive: true,
        });
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    runElectronQuarantine().catch(error => {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    });
}
