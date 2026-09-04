import { isRecord } from '@contracts/runtimeGuards';
import {
    combineOutcomes,
    findResultIdentityMismatches,
    isWindowsTestEvidenceManifest,
    isWindowsTestResult,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestEvidenceManifest,
    IWindowsTestJob,
    IWindowsTestResult,
    IWindowsTestWorkerHeartbeat,
    TWindowsTestOutcome,
} from '@scripts/windows-test/contracts/windowsTestContracts';

export const windowsTestRejectionReasons = [
    'result-missing',
    'result-malformed',
    'guest-error-response',
    'result-identity-mismatch',
    'artifact-hash-mismatch',
    'evidence-manifest-missing',
    'evidence-manifest-malformed',
    'evidence-manifest-hash-mismatch',
    'evidence-file-missing',
    'evidence-file-hash-mismatch',
    'heartbeat-missing',
    'heartbeat-stale',
    'worker-session-not-interactive',
    'desktop-locked',
] as const;

export type TWindowsTestRejectionReason = typeof windowsTestRejectionReasons[number];

export interface IWindowsTestRejection {
    reason: TWindowsTestRejectionReason;
    detail: string;
    outcome: Extract<TWindowsTestOutcome, 'infrastructure-failed' | 'product-failed'>;
}

export interface IWindowsTestObservedEvidenceFile {
    relativePath: string;
    sha256: string;
    bytes: number;
}

export interface IWindowsTestResultValidationInput {
    job: IWindowsTestJob;
    resultText: string | null;
    evidenceManifestText: string | null;
    evidenceManifestSha256: string | null;
    observedEvidenceFiles: readonly IWindowsTestObservedEvidenceFile[];
    heartbeat: IWindowsTestWorkerHeartbeat | null;
    heartbeatAgeMs: number | null;
    heartbeatStaleAfterMs: number;
}

export type TWindowsTestResultValidation =
    | {
        ok: true;
        result: IWindowsTestResult;
        evidenceManifest: IWindowsTestEvidenceManifest;
        rejections: [];
    }
    | {
        ok: false;
        result: null;
        evidenceManifest: null;
        rejections: IWindowsTestRejection[];
    };

function infrastructureRejection(
    reason: TWindowsTestRejectionReason,
    detail: string,
): IWindowsTestRejection {
    return {
        reason,
        detail,
        outcome: 'infrastructure-failed',
    };
}

// A worker that stops writing its heartbeat is broken test infrastructure. A
// crashed application under test is a product failure and is reported by the
// guest result itself, never by this gate.
export function evaluateWorkerHeartbeat(
    job: IWindowsTestJob,
    heartbeat: IWindowsTestWorkerHeartbeat | null,
    heartbeatAgeMs: number | null,
    heartbeatStaleAfterMs: number,
): IWindowsTestRejection[] {
    if (heartbeat === null) {
        return [infrastructureRejection(
            'heartbeat-missing',
            'The guest worker never published a heartbeat with an interactive desktop identity.',
        )];
    }
    const rejections: IWindowsTestRejection[] = [];
    if (heartbeatAgeMs !== null && heartbeatAgeMs > heartbeatStaleAfterMs) {
        rejections.push(infrastructureRejection(
            'heartbeat-stale',
            `The guest worker heartbeat stopped ${heartbeatAgeMs} ms ago, past the ${heartbeatStaleAfterMs} ms budget; the worker crashed.`,
        ));
    }
    if (heartbeat.bootId !== job.bootId) {
        rejections.push(infrastructureRejection(
            'result-identity-mismatch',
            `The heartbeat boot ID ${heartbeat.bootId} does not match the job boot ID ${job.bootId}; the record is stale.`,
        ));
    }
    if (!heartbeat.worker.interactive || heartbeat.worker.sessionId === 0) {
        rejections.push(infrastructureRejection(
            'worker-session-not-interactive',
            `The guest worker ran in session ${heartbeat.worker.sessionId} without an interactive desktop; a Session 0 launch is not a user journey.`,
        ));
    }
    if (heartbeat.worker.inputDesktop !== 'Default' || heartbeat.locked) {
        rejections.push(infrastructureRejection(
            'desktop-locked',
            `The guest input desktop was "${heartbeat.worker.inputDesktop}"${heartbeat.locked ? ' and the session was locked' : ''}; injected input cannot be certified.`,
        ));
    }
    return rejections;
}

function parseResultPayload(resultText: string): {
    result: IWindowsTestResult | null;
    rejection: IWindowsTestRejection | null;
} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(resultText);
    } catch (error) {
        return {
            result: null,
            rejection: infrastructureRejection(
                'result-malformed',
                `The guest result payload is not valid JSON: ${String(error)}.`,
            ),
        };
    }
    if (isWindowsTestResult(parsed)) {
        return {
            result: parsed,
            rejection: null,
        };
    }
    // A zero transport exit alongside an error payload must never read as a
    // pass (invariant I3).
    if (isRecord(parsed) && typeof parsed.error === 'string') {
        return {
            result: null,
            rejection: infrastructureRejection(
                'guest-error-response',
                `The guest returned an error response instead of a completion record: ${parsed.error}.`,
            ),
        };
    }
    return {
        result: null,
        rejection: infrastructureRejection(
            'result-malformed',
            'The guest result payload does not match the Windows test result schema.',
        ),
    };
}

function validateEvidence(
    job: IWindowsTestJob,
    result: IWindowsTestResult,
    input: IWindowsTestResultValidationInput,
): {
    manifest: IWindowsTestEvidenceManifest | null;
    rejections: IWindowsTestRejection[];
} {
    if (input.evidenceManifestText === null) {
        return {
            manifest: null,
            rejections: [infrastructureRejection(
                'evidence-manifest-missing',
                'The guest evidence manifest was not collected.',
            )],
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(input.evidenceManifestText);
    } catch (error) {
        return {
            manifest: null,
            rejections: [infrastructureRejection(
                'evidence-manifest-malformed',
                `The guest evidence manifest is not valid JSON: ${String(error)}.`,
            )],
        };
    }
    if (!isWindowsTestEvidenceManifest(parsed) || parsed.runId !== job.runId) {
        return {
            manifest: null,
            rejections: [infrastructureRejection(
                'evidence-manifest-malformed',
                'The guest evidence manifest does not match the evidence manifest schema for this run.',
            )],
        };
    }

    const rejections: IWindowsTestRejection[] = [];
    if (input.evidenceManifestSha256 !== result.evidenceManifestSha256) {
        rejections.push(infrastructureRejection(
            'evidence-manifest-hash-mismatch',
            `The collected evidence manifest hashes to ${String(input.evidenceManifestSha256)} but the result declares ${result.evidenceManifestSha256}.`,
        ));
    }
    const observed = new Map(input.observedEvidenceFiles.map(entry => [
        entry.relativePath,
        entry,
    ]));
    for (const entry of parsed.entries) {
        const match = observed.get(entry.relativePath);
        if (match === undefined) {
            rejections.push(infrastructureRejection(
                'evidence-file-missing',
                `Evidence file ${entry.relativePath} listed in the manifest was not collected.`,
            ));
            continue;
        }
        if (match.sha256 !== entry.sha256 || match.bytes !== entry.bytes) {
            rejections.push(infrastructureRejection(
                'evidence-file-hash-mismatch',
                `Evidence file ${entry.relativePath} does not match its manifest hash or size.`,
            ));
        }
    }
    return {
        manifest: parsed,
        rejections,
    };
}

export function validateWindowsTestResultBundle(
    input: IWindowsTestResultValidationInput,
): TWindowsTestResultValidation {
    const heartbeatRejections = evaluateWorkerHeartbeat(
        input.job,
        input.heartbeat,
        input.heartbeatAgeMs,
        input.heartbeatStaleAfterMs,
    );

    if (input.resultText === null) {
        return {
            ok: false,
            result: null,
            evidenceManifest: null,
            rejections: [
                ...heartbeatRejections,
                infrastructureRejection(
                    'result-missing',
                    `No guest completion record was published for run ${input.job.runId} before its deadline.`,
                ),
            ],
        };
    }

    const {
        result,
        rejection,
    } = parseResultPayload(input.resultText);
    if (result === null) {
        return {
            ok: false,
            result: null,
            evidenceManifest: null,
            rejections: [
                ...heartbeatRejections,
                ...(rejection === null ? [] : [rejection]),
            ],
        };
    }

    const rejections = [...heartbeatRejections];
    if (result.artifactSha256 !== input.job.artifactSha256) {
        rejections.push(infrastructureRejection(
            'artifact-hash-mismatch',
            `The guest tested artifact ${result.artifactSha256} instead of the staged ${input.job.artifactSha256}.`,
        ));
    }
    for (const mismatch of findResultIdentityMismatches(input.job, result)) {
        if (mismatch.field === 'artifactSha256') {
            continue;
        }
        rejections.push(infrastructureRejection(
            'result-identity-mismatch',
            `The guest result field ${mismatch.field} is "${mismatch.actual}" but the job requires "${mismatch.expected}".`,
        ));
    }
    if (!result.worker.interactive || result.worker.sessionId === 0) {
        rejections.push(infrastructureRejection(
            'worker-session-not-interactive',
            `The guest result reports session ${result.worker.sessionId} without an interactive desktop.`,
        ));
    }

    const evidence = validateEvidence(input.job, result, input);
    rejections.push(...evidence.rejections);

    if (rejections.length > 0 || evidence.manifest === null) {
        return {
            ok: false,
            result: null,
            evidenceManifest: null,
            rejections,
        };
    }

    return {
        ok: true,
        result,
        evidenceManifest: evidence.manifest,
        rejections: [],
    };
}

export function outcomeForRejections(rejections: readonly IWindowsTestRejection[]) {
    return rejections.reduce<TWindowsTestOutcome>(
        (outcome, rejection) => combineOutcomes(outcome, rejection.outcome),
        'infrastructure-failed',
    );
}
