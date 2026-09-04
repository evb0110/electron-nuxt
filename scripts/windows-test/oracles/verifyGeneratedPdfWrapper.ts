import path from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import { createOracleResult } from '@scripts/windows-test/oracles/oracleResult';

export const GENERATED_PDF_VERIFIER_ORACLE_ID = 'generated-pdf-verifier';

export const GENERATED_PDF_VERIFIER_SCRIPT = path.join('scripts', 'diagnostics', 'verify-generated-pdf.py');

export const GENERATED_PDF_VERIFIER_VERSION = 'scripts/diagnostics/verify-generated-pdf.py';

export interface IVerifyProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export type TVerifyProcessRunner = (
    command: string,
    args: readonly string[],
) => Promise<IVerifyProcessResult>;

export interface IVerifyGeneratedPdfOptions {
    repositoryRoot: string;
    pdfPath: string;
    artifactDirectory: string;
    pages?: readonly number[];
    dpi?: number;
    allowLarge?: boolean;
    pythonExecutable?: string;
    runner: TVerifyProcessRunner;
}

export const GENERATED_PDF_VERIFIER_PASS_STATUSES = [
    'classified-compatible',
    'requires-compatible-renderer',
] as const;

const MISSING_DEPENDENCY_MARKERS = [
    'ModuleNotFoundError',
    'No module named',
    'command not found',
    'Required command is unavailable',
    'ENOENT',
];

export function buildVerifyGeneratedPdfArgs(options: IVerifyGeneratedPdfOptions) {
    const args = [
        path.join(options.repositoryRoot, GENERATED_PDF_VERIFIER_SCRIPT),
        `--pdf=${options.pdfPath}`,
        `--artifact-dir=${options.artifactDirectory}`,
    ];
    if (options.pages !== undefined && options.pages.length > 0) {
        args.push(`--pages=${options.pages.join(',')}`);
    }
    if (options.dpi !== undefined) {
        args.push(`--dpi=${options.dpi}`);
    }
    if (options.allowLarge === true) {
        args.push('--allow-large');
    }
    return args;
}

// The verifier prints one JSON document that may span lines and may be
// preceded by progress lines, so every line-leading brace is tried in order.
function parseVerifierStdout(stdout: string) {
    const lines = stdout.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        if (!(lines[index] ?? '').trimStart().startsWith('{')) {
            continue;
        }
        const candidate = lines.slice(index).join('\n').trim();
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (isRecord(parsed)) {
                return parsed;
            }
        } catch {
            // Not the payload; keep scanning.
        }
    }
    return null;
}

function looksLikeMissingDependency(result: IVerifyProcessResult) {
    const combined = `${result.stdout}\n${result.stderr}`;
    return MISSING_DEPENDENCY_MARKERS.some(marker => combined.includes(marker));
}

/**
 * Wraps the tracked generated-PDF verifier instead of reimplementing a weaker
 * Windows-only blankness check. A missing python3 or Pillow is reported as
 * inconclusive, never as a pass.
 */
export async function runVerifyGeneratedPdf(
    options: IVerifyGeneratedPdfOptions,
): Promise<IOracleResult> {
    const command = options.pythonExecutable ?? 'python3';
    const args = buildVerifyGeneratedPdfArgs(options);
    let processResult: IVerifyProcessResult;
    try {
        processResult = await options.runner(command, args);
    } catch (error) {
        return createOracleResult({
            oracleId: GENERATED_PDF_VERIFIER_ORACLE_ID,
            oracleVersion: GENERATED_PDF_VERIFIER_VERSION,
            status: 'inconclusive',
            detail: `The verifier could not be started: ${error instanceof Error ? error.message : String(error)}`,
            observations: {
                command,
                args,
            },
        });
    }
    const report = parseVerifierStdout(processResult.stdout);
    if (processResult.exitCode !== 0 && report === null && looksLikeMissingDependency(processResult)) {
        return createOracleResult({
            oracleId: GENERATED_PDF_VERIFIER_ORACLE_ID,
            oracleVersion: GENERATED_PDF_VERIFIER_VERSION,
            status: 'inconclusive',
            detail: 'python3 or its imaging dependency is unavailable on this host; the verifier did not run.',
            observations: {
                command,
                exitCode: processResult.exitCode,
                stderr: processResult.stderr.slice(0, 2000),
            },
        });
    }
    if (report === null) {
        return createOracleResult({
            oracleId: GENERATED_PDF_VERIFIER_ORACLE_ID,
            oracleVersion: GENERATED_PDF_VERIFIER_VERSION,
            status: processResult.exitCode === 0 ? 'inconclusive' : 'failed',
            detail: 'The verifier produced no parsable report.',
            observations: {
                exitCode: processResult.exitCode,
                stdout: processResult.stdout.slice(0, 2000),
                stderr: processResult.stderr.slice(0, 2000),
            },
        });
    }
    const status = typeof report.status === 'string' ? report.status : 'unknown';
    const acceptedStatus = GENERATED_PDF_VERIFIER_PASS_STATUSES.some(entry => entry === status);
    return createOracleResult({
        oracleId: GENERATED_PDF_VERIFIER_ORACLE_ID,
        oracleVersion: GENERATED_PDF_VERIFIER_VERSION,
        status: processResult.exitCode === 0 && acceptedStatus ? 'passed' : 'failed',
        detail: `Verifier reported ${status} with exit code ${processResult.exitCode}.`,
        observations: {
            report,
            exitCode: processResult.exitCode,
        },
    });
}
