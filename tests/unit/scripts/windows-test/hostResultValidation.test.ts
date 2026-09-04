import { createHash } from 'node:crypto';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IWindowsTestJob,
    IWindowsTestResult,
    IWindowsTestWorkerHeartbeat,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    evaluateWorkerHeartbeat,
    outcomeForRejections,
    validateWindowsTestResultBundle,
} from '@scripts/windows-test/host/resultValidation';
import type { IWindowsTestResultValidationInput } from '@scripts/windows-test/host/resultValidation';

const RUN_ID = '20260904T120000Z-0123456789ab';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';
const ARTIFACT_SHA = 'a'.repeat(64);
const OTHER_SHA = 'c'.repeat(64);
const BOOT_ID = 'boot-2026-09-04-01';
const MARKER = 'evb-windows-test-marker-2026-09';

const job: IWindowsTestJob = {
    schemaVersion: 1,
    runId: RUN_ID,
    sourceSha: 'b'.repeat(40),
    artifactSha256: ARTIFACT_SHA,
    artifactFileName: 'EVBViewer-Setup.exe',
    imageId: 'win11-arm64-2026-09',
    vmId: CLONE_VM_ID,
    bootId: BOOT_ID,
    guestTestMarker: MARKER,
    runnerVersion: '2026-09-04.1',
    suite: 'smoke',
    tests: ['WIN-SAVE-01'],
    fixtureManifestSha256: 'd'.repeat(64),
    expectedOsArch: 'arm64',
    expectedAppArch: 'arm64',
    deadlineSeconds: 1_200,
};

function evidenceManifest(runId = RUN_ID) {
    return JSON.stringify({
        schemaVersion: 1,
        runId,
        entries: [{
            relativePath: 'screenshots/save.png',
            sha256: 'e'.repeat(64),
            bytes: 4_096,
        }],
    });
}

const evidenceManifestSha = createHash('sha256').update(evidenceManifest()).digest('hex');

function heartbeat(overrides: Partial<IWindowsTestWorkerHeartbeat> = {}): IWindowsTestWorkerHeartbeat {
    return {
        schemaVersion: 1,
        bootId: BOOT_ID,
        guestTestMarker: MARKER,
        updatedAt: '2026-09-04T12:05:00.000Z',
        locked: false,
        worker: {
            userSid: 'S-1-5-21-1-2-3-1001',
            sessionId: 1,
            integrityLevel: 'Medium',
            inputDesktop: 'Default',
            interactive: true,
            workerPid: 4_242,
            workerStartTime: '2026-09-04T12:00:00.000Z',
        },
        ...overrides,
    };
}

function result(overrides: Partial<IWindowsTestResult> = {}): IWindowsTestResult {
    return {
        schemaVersion: 1,
        runId: RUN_ID,
        vmId: CLONE_VM_ID,
        imageId: 'win11-arm64-2026-09',
        bootId: BOOT_ID,
        guestTestMarker: MARKER,
        artifactSha256: ARTIFACT_SHA,
        runnerVersion: '2026-09-04.1',
        terminalState: 'complete',
        outcome: 'passed',
        startedAt: '2026-09-04T12:01:00.000Z',
        endedAt: '2026-09-04T12:06:00.000Z',
        expectedTests: ['WIN-SAVE-01'],
        executedTests: ['WIN-SAVE-01'],
        assertionCount: 3,
        failedAssertionCount: 0,
        cases: [{
            testId: 'WIN-SAVE-01',
            driver: 'APP',
            actionKind: 'app',
            outcome: 'passed',
            startedAt: '2026-09-04T12:01:00.000Z',
            endedAt: '2026-09-04T12:03:00.000Z',
            assertions: [{
                id: 'saved-file-exists',
                passed: true,
                detail: 'The saved document exists on disk.',
            }],
            evidenceFiles: ['screenshots/save.png'],
            failureReason: null,
        }],
        worker: heartbeat().worker,
        platform: {
            osVersion: '10.0.26100.1',
            osArch: 'arm64',
            appVersion: '3.4.5',
            appArch: 'arm64',
            installedExecutableSha256: 'f'.repeat(64),
            hostname: 'EVB-WIN-TEST',
        },
        evidenceManifestSha256: evidenceManifestSha,
        logTruncated: false,
        humanReviewRequired: false,
        failureReason: null,
        ...overrides,
    };
}

function input(overrides: Partial<IWindowsTestResultValidationInput> = {}): IWindowsTestResultValidationInput {
    return {
        job,
        resultText: JSON.stringify(result()),
        evidenceManifestText: evidenceManifest(),
        evidenceManifestSha256: evidenceManifestSha,
        observedEvidenceFiles: [{
            relativePath: 'screenshots/save.png',
            sha256: 'e'.repeat(64),
            bytes: 4_096,
        }],
        heartbeat: heartbeat(),
        heartbeatAgeMs: 1_000,
        heartbeatStaleAfterMs: 60_000,
        ...overrides,
    };
}

function reasons(validation: ReturnType<typeof validateWindowsTestResultBundle>) {
    return validation.rejections.map(rejection => rejection.reason);
}

describe('windows test result negative controls', () => {
    it('accepts a complete, identity-matched result bundle', () => {
        const validation = validateWindowsTestResultBundle(input());

        expect(validation.ok).toBe(true);
        expect(validation.result?.outcome).toBe('passed');
    });

    it('rejects a missing completion record', () => {
        const validation = validateWindowsTestResultBundle(input({resultText: null}));

        expect(reasons(validation)).toContain('result-missing');
        expect(outcomeForRejections(validation.rejections)).toBe('infrastructure-failed');
    });

    it('rejects a malformed completion record', () => {
        expect(reasons(validateWindowsTestResultBundle(input({resultText: '{ broken'})))).toContain('result-malformed');
        expect(reasons(validateWindowsTestResultBundle(input({resultText: '{"outcome":"passed"}'})))).toContain('result-malformed');
    });

    it('rejects an error response that arrived with a zero transport exit', () => {
        const validation = validateWindowsTestResultBundle(input({resultText: JSON.stringify({error: 'the worker could not start the application'})}));

        expect(reasons(validation)).toContain('guest-error-response');
        expect(outcomeForRejections(validation.rejections)).toBe('infrastructure-failed');
    });

    it('rejects a stale result from another run or another boot', () => {
        expect(reasons(validateWindowsTestResultBundle(input({resultText: JSON.stringify(result({runId: '20260903T090000Z-abcdefabcdef'}))})))).toContain('result-identity-mismatch');
        expect(reasons(validateWindowsTestResultBundle(input({resultText: JSON.stringify(result({bootId: 'boot-from-a-previous-run'}))})))).toContain('result-identity-mismatch');
    });

    it('rejects a result that tested a different artifact', () => {
        const validation = validateWindowsTestResultBundle(input({resultText: JSON.stringify(result({artifactSha256: OTHER_SHA}))}));

        expect(reasons(validation)).toContain('artifact-hash-mismatch');
    });

    it('rejects a result produced without an interactive desktop', () => {
        const validation = validateWindowsTestResultBundle(input({
            heartbeat: heartbeat({worker: {
                ...heartbeat().worker,
                sessionId: 0,
                interactive: false,
            }}),
            resultText: JSON.stringify(result({worker: {
                ...heartbeat().worker,
                sessionId: 0,
                interactive: false,
            }})),
        }));

        expect(reasons(validation)).toContain('worker-session-not-interactive');
    });

    it('rejects a locked session even when the worker claims to be interactive', () => {
        const validation = validateWindowsTestResultBundle(input({heartbeat: heartbeat({locked: true})}));

        expect(reasons(validation)).toContain('desktop-locked');
    });

    it('treats a worker that stopped heartbeating as infrastructure, not product, failure', () => {
        const validation = validateWindowsTestResultBundle(input({
            heartbeatAgeMs: 120_000,
            resultText: null,
        }));

        expect(reasons(validation)).toEqual(expect.arrayContaining([
            'heartbeat-stale',
            'result-missing',
        ]));
        expect(outcomeForRejections(validation.rejections)).toBe('infrastructure-failed');
    });

    it('reports a crashed application as the guest classified it', () => {
        const validation = validateWindowsTestResultBundle(input({resultText: JSON.stringify(result({
            outcome: 'product-failed',
            failedAssertionCount: 1,
            failureReason: 'The application under test crashed while saving.',
            cases: [{
                ...result().cases[0]!,
                outcome: 'product-failed',
                failureReason: 'The application under test crashed while saving.',
            }],
        }))}));

        expect(validation.ok).toBe(true);
        expect(validation.result?.outcome).toBe('product-failed');
    });

    it('rejects missing, malformed and mis-hashed evidence', () => {
        expect(reasons(validateWindowsTestResultBundle(input({evidenceManifestText: null}))))
            .toContain('evidence-manifest-missing');
        expect(reasons(validateWindowsTestResultBundle(input({evidenceManifestText: 'not json'}))))
            .toContain('evidence-manifest-malformed');
        expect(reasons(validateWindowsTestResultBundle(input({evidenceManifestSha256: OTHER_SHA}))))
            .toContain('evidence-manifest-hash-mismatch');
        expect(reasons(validateWindowsTestResultBundle(input({observedEvidenceFiles: []}))))
            .toContain('evidence-file-missing');
        expect(reasons(validateWindowsTestResultBundle(input({observedEvidenceFiles: [{
            relativePath: 'screenshots/save.png',
            sha256: OTHER_SHA,
            bytes: 4_096,
        }]})))).toContain('evidence-file-hash-mismatch');
    });

    it('reports an absent heartbeat on its own', () => {
        expect(evaluateWorkerHeartbeat(job, null, null, 60_000).map(rejection => rejection.reason))
            .toEqual(['heartbeat-missing']);
    });
});
