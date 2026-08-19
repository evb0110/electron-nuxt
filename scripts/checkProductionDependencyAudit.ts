import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const BULK_AUDIT_PNPM_VERSION = '11.13.1';
const AUDIT_SEVERITIES = [
    'info',
    'low',
    'moderate',
    'high',
    'critical',
] as const;

type TAuditSeverity = typeof AUDIT_SEVERITIES[number];

interface IAuditSummary {
    counts: Record<TAuditSeverity, number>;
    total: number;
}

interface IAuditProject {
    cwd: string;
    label: string;
    scope: 'all' | 'prod';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseAuditReport(source: string, label: string) {
    let report: unknown;

    try {
        report = JSON.parse(source) as unknown;
    } catch (error) {
        throw new Error(`${label} pnpm audit did not return valid JSON.`, {cause: error});
    }

    if (!isRecord(report)) {
        throw new Error(`${label} pnpm audit report must be an object.`);
    }

    return report;
}

export function shouldUseBulkAuditFallback(source: string) {
    return source.includes('ERR_PNPM_AUDIT_BAD_RESPONSE')
        && source.includes('endpoint is being retired');
}

export function summarizeProductionAuditReport(report: unknown, label = 'project'): IAuditSummary {
    if (!isRecord(report)) {
        throw new Error(`${label} pnpm audit report must be an object.`);
    }

    const metadata = report.metadata;
    if (!isRecord(metadata)) {
        throw new Error(`${label} pnpm audit report is missing metadata.vulnerabilities.`);
    }
    const vulnerabilities = metadata.vulnerabilities;
    if (!isRecord(vulnerabilities)) {
        throw new Error(`${label} pnpm audit report is missing metadata.vulnerabilities.`);
    }

    const muted = report.muted;
    if (Array.isArray(muted) && muted.length > 0) {
        throw new Error(`${label} pnpm audit report contains ${muted.length} muted advisories; checked-in audit policy does not permit hidden production vulnerabilities.`);
    }

    const counts = Object.fromEntries(AUDIT_SEVERITIES.map((severity) => {
        const count = vulnerabilities[severity];
        if (!Number.isSafeInteger(count) || Number(count) < 0) {
            throw new Error(`${label} pnpm audit report has an invalid ${severity} vulnerability count.`);
        }

        return [
            severity,
            Number(count),
        ];
    })) as Record<TAuditSeverity, number>;

    return {
        counts,
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
}

export function assertProductionAuditIsClean(report: unknown, label = 'project') {
    const summary = summarizeProductionAuditReport(report, label);
    if (summary.total === 0) {
        return summary;
    }

    const details = AUDIT_SEVERITIES
        .filter(severity => summary.counts[severity] > 0)
        .map(severity => `${severity}=${summary.counts[severity]}`)
        .join(', ');
    throw new Error(`${label} dependency audit found ${summary.total} vulnerabilities (${details}).`);
}

function runProjectAudit(project: IAuditProject) {
    const scopeArgs = project.scope === 'prod' ? ['--prod'] : [];
    let result = spawnSync('pnpm', [
        'audit',
        ...scopeArgs,
        '--json',
    ], {
        cwd: project.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === 'win32',
    });

    if (shouldUseBulkAuditFallback(result.stdout)) {
        result = spawnSync('corepack', [
            `pnpm@${BULK_AUDIT_PNPM_VERSION}`,
            '--pm-on-fail=ignore',
            'audit',
            ...scopeArgs,
            '--json',
        ], {
            cwd: project.cwd,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            shell: process.platform === 'win32',
        });
    }

    if (result.error !== undefined) {
        throw new Error(`${project.label} pnpm audit could not start.`, {cause: result.error});
    }

    const report = parseAuditReport(result.stdout, project.label);
    const summary = assertProductionAuditIsClean(report, project.label);

    if (result.status !== 0) {
        const detail = result.stderr.trim();
        throw new Error(`${project.label} pnpm audit failed with exit code ${result.status}${detail === '' ? '' : `: ${detail}`}`);
    }

    console.log(`${project.label} dependency audit passed (${summary.total} vulnerabilities).`);
}

export function runProductionDependencyAudits({includeFullGraph = true} = {}) {
    runProjectAudit({
        cwd: PROJECT_ROOT,
        label: 'workspace production',
        scope: 'prod',
    });
    if (!includeFullGraph) {
        return;
    }

    runProjectAudit({
        cwd: PROJECT_ROOT,
        label: 'workspace full graph (Electron runtime and build tooling)',
        scope: 'all',
    });
}

function isDirectExecution() {
    const entryPath = process.argv[1];
    return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isDirectExecution()) {
    runProductionDependencyAudits({includeFullGraph: !process.argv.includes('--production-only')});
}
