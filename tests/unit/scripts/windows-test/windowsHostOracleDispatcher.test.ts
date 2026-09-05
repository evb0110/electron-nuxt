import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {loadCapabilityRegistry} from '@scripts/windows-test/registry/capabilityRegistry';
import {generateNegativeControls} from '@scripts/windows-test/fixtures/generateNegativeControls';
import {generateNumberedFixture} from '@scripts/windows-test/fixtures/generateNumberedFixture';
import {extractPageTexts} from '@scripts/windows-test/oracles/pageMarkerOracle';
import type {
    IWindowsTestCaseResult,
    IWindowsTestResult,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    findWindowsHostOraclePlan,
    runWindowsHostOracles,
    validateWindowsHostOraclePlan,
    windowsHostOraclePlans,
} from '@scripts/windows-test/oracles/windowsHostOracleDispatcher';
import {windowsHostOracleIds} from '@scripts/windows-test/oracles/oracleRegistry';

const repositoryRoot = process.cwd();
const runId = '20260905T020000Z-0123456789ab';
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-host-oracles-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

function guestCase(testId: string, evidenceFiles: readonly string[]): IWindowsTestCaseResult {
    return {
        testId,
        driver: testId === 'WIN-PRINT-01' ? 'WIN' : 'APP',
        actionKind: 'app',
        outcome: 'passed',
        startedAt: '2026-09-05T02:00:00.000Z',
        endedAt: '2026-09-05T02:01:00.000Z',
        assertions: [{
            id: `${testId}.complete`,
            passed: true,
            detail: 'The guest completed the case.',
        }],
        evidenceFiles: [...evidenceFiles],
        failureReason: null,
    };
}

function guestResult(testId: string, evidenceFiles: readonly string[]): IWindowsTestResult {
    return {
        schemaVersion: 1,
        runId,
        vmId: '33333333-4444-4555-8666-777777777777',
        imageId: 'win11-arm64-2026-09',
        bootId: 'boot-2026-09-05-01',
        guestTestMarker: 'evb-windows-test-marker-2026-09',
        artifactSha256: 'a'.repeat(64),
        runnerVersion: '2026-09-05.1',
        terminalState: 'complete',
        outcome: 'passed',
        startedAt: '2026-09-05T02:00:00.000Z',
        endedAt: '2026-09-05T02:01:00.000Z',
        expectedTests: [testId],
        executedTests: [testId],
        assertionCount: 1,
        failedAssertionCount: 0,
        cases: [guestCase(testId, evidenceFiles)],
        worker: {
            userSid: 'S-1-5-21-1-2-3-1001',
            sessionId: 1,
            integrityLevel: 'Medium',
            inputDesktop: 'Default',
            interactive: true,
            workerPid: 4242,
            workerStartTime: '2026-09-05T02:00:00.000Z',
        },
        platform: {
            osVersion: '10.0.26100.1',
            osArch: 'arm64',
            appVersion: '0.1.450',
            appArch: 'arm64',
            installedExecutableSha256: 'f'.repeat(64),
            hostname: 'EVB-WIN-TEST',
        },
        evidenceManifestSha256: 'e'.repeat(64),
        logTruncated: false,
        humanReviewRequired: false,
        failureReason: null,
    };
}

async function writeArtifact(evidenceDirectory: string, relativePath: string, bytes: Uint8Array) {
    const target = path.join(evidenceDirectory, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
}

function verifierRunner() {
    return async () => ({
        exitCode: 0,
        stdout: JSON.stringify({status: 'classified-compatible'}),
        stderr: '',
    });
}

async function runPlan(
    testId: string,
    artifacts: Readonly<Record<string, Uint8Array>>,
) {
    const root = await temporaryDirectory();
    const evidenceDirectory = path.join(root, 'evidence');
    const plan = findWindowsHostOraclePlan(testId);
    if (plan === null) {
        throw new Error(`No host plan for ${testId}`);
    }
    for (const [
        relativePath,
        bytes,
    ] of Object.entries(artifacts)) {
        await writeArtifact(evidenceDirectory, relativePath, bytes);
    }
    const resultsFile = path.join(root, 'oracle-results.json');
    const evidenceFiles = Object.keys(artifacts);
    const ocrOutputs: string[] = [];
    for (const target of plan.pdfTargets.filter(candidate => candidate.pageMarkerMode === 'ocr')) {
        const bytes = artifacts[target.artifactPath];
        if (bytes === undefined) {
            continue;
        }
        const observations = await extractPageTexts(bytes, repositoryRoot);
        ocrOutputs.push(...observations.map(observation => {
            const marker = /EVB-[A-Z0-9-]+/u.exec(observation.text);
            return marker?.[0] ?? '';
        }));
    }
    let ocrCall = 0;
    const dispatch = await runWindowsHostOracles({
        runId,
        environmentId: 'utm-win11-arm64-app-arm64',
        repositoryRoot,
        evidenceDirectory,
        resultsFile,
        result: guestResult(testId, evidenceFiles),
        verifyProcessRunner: verifierRunner(),
        ocrProcessRunner: async () => ({
            exitCode: 0,
            stdout: `${ocrOutputs[ocrCall++] ?? ''}\n`,
            stderr: '',
            timedOut: false,
        }),
    });
    const report = JSON.parse(await readFile(resultsFile, 'utf8')) as {
        outcome: string;
        status: string;
        results: Array<{
            oracleId: string;
            status: string;
            side: string;
            provenance: string
        }>;
        errors: string[];
    };
    return {
        dispatch,
        plan,
        report,
        resultsFile,
    };
}

async function blankSamePageCount() {
    const document = await PDFDocument.create();
    for (let index = 0; index < 12; index += 1) {
        document.addPage([
            595.28,
            841.89,
        ]);
    }
    return document.save({ useObjectStreams: false });
}

async function editedNumberedFixture() {
    const source = await PDFDocument.load(await generateNumberedFixture());
    const edited = await PDFDocument.create();
    const pages = await edited.copyPages(source, [
        0,
        1,
        3,
        4,
        6,
        7,
        8,
        9,
        10,
        11,
    ]);
    for (const page of pages) {
        edited.addPage(page);
    }
    return edited.save({ useObjectStreams: false });
}

describe('windows host oracle dispatcher', () => {
    let numbered: Uint8Array;
    let blank: Uint8Array;
    let wrongMarkers: Uint8Array;

    beforeAll(async () => {
        numbered = await generateNumberedFixture();
        blank = await blankSamePageCount();
        wrongMarkers = (await generateNegativeControls()).wrongPageMarkers;
    });

    it('runs real host oracles on both print outputs and persists provenance', async () => {
        const result = await runPlan('WIN-PRINT-01', {
            'artifacts/WIN-PRINT-01/source.pdf': numbered,
            'artifacts/WIN-PRINT-01/cold.pdf': numbered,
            'artifacts/WIN-PRINT-01/warm.pdf': numbered,
        });

        expect(result.dispatch.outcome).toBe('passed');
        expect(result.dispatch.status).toBe('passed');
        expect(result.report.outcome).toBe('passed');
        expect(result.report.results).toHaveLength(10);
        expect(result.report.results.every(entry => entry.side === 'host')).toBe(true);
        expect(result.report.results.every(entry => entry.provenance.includes('scripts/windows-test/oracles'))).toBe(true);
        expect(result.report.results.every(entry => entry.status === 'passed')).toBe(true);
    }, 30_000);

    it('rejects a blank PDF with the expected page count', async () => {
        const result = await runPlan('WIN-PRINT-01', {
            'artifacts/WIN-PRINT-01/source.pdf': numbered,
            'artifacts/WIN-PRINT-01/cold.pdf': blank,
            'artifacts/WIN-PRINT-01/warm.pdf': blank,
        });

        expect(result.dispatch.outcome).toBe('product-failed');
        expect(result.report.results.some(entry => entry.oracleId === 'page-count' && entry.status === 'passed')).toBe(true);
        expect(result.report.results.some(entry => entry.oracleId === 'page-markers' && entry.status === 'failed')).toBe(true);
        expect(result.report.results.some(entry => entry.oracleId === 'render-nonblank' && entry.status === 'failed')).toBe(true);
    }, 30_000);

    it('rejects a same-shape PDF whose page markers are wrong', async () => {
        const result = await runPlan('WIN-PRINT-01', {
            'artifacts/WIN-PRINT-01/source.pdf': numbered,
            'artifacts/WIN-PRINT-01/cold.pdf': wrongMarkers,
            'artifacts/WIN-PRINT-01/warm.pdf': wrongMarkers,
        });

        expect(result.dispatch.outcome).toBe('product-failed');
        expect(result.report.results.some(entry => entry.oracleId === 'page-markers' && entry.status === 'failed')).toBe(true);
        expect(result.report.results.some(entry => entry.oracleId === 'render-nonblank' && entry.status === 'passed')).toBe(true);
    }, 30_000);

    it('classifies a missing required artifact as infrastructure failure', async () => {
        const result = await runPlan('WIN-PRINT-01', {
            'artifacts/WIN-PRINT-01/source.pdf': numbered,
            'artifacts/WIN-PRINT-01/cold.pdf': numbered,
        });

        expect(result.dispatch.outcome).toBe('infrastructure-failed');
        expect(result.dispatch.status).toBe('inconclusive');
        expect(result.report.errors.some(error => error.includes('warm.pdf'))).toBe(true);
    });

    it('runs the changed-source isolation check from host evidence', async () => {
        const edited = await editedNumberedFixture();
        const result = await runPlan('WIN-SAVE-01', {
            'artifacts/WIN-SAVE-01/source-before.pdf': numbered,
            'artifacts/WIN-SAVE-01/source-after.pdf': edited,
        });

        expect(result.dispatch.outcome).toBe('passed');
        expect(result.report.results.find(entry => entry.oracleId === 'source-isolation')?.status).toBe('passed');
    });

    it('keeps planned rows outside the bounded host plan', async () => {
        expect(findWindowsHostOraclePlan('WIN-SAVE-03')).toBeNull();
        expect(windowsHostOraclePlans.some(plan => plan.caseId === 'WIN-SAVE-03')).toBe(false);
        const registry = await loadCapabilityRegistry(
            path.join(repositoryRoot, 'tests', 'windows', 'capabilities.json'),
        );
        for (const plan of windowsHostOraclePlans) {
            const capability = registry.cases.find(entry => entry.id === plan.caseId);
            expect(capability, plan.caseId).toBeDefined();
            const declaredHostOracleIds = capability?.oracles
                .filter(oracleId => windowsHostOracleIds.includes(oracleId))
                .sort();
            expect(declaredHostOracleIds).toEqual([...plan.hostOracleIds].sort());
        }
    });

    it('has a complete deterministic expectation for every bounded plan', () => {
        for (const plan of windowsHostOraclePlans) {
            expect(validateWindowsHostOraclePlan(plan), plan.caseId).toEqual([]);
        }
    });

    it('reserves OCR for WIN-PRINT-01 cold and warm artifacts and keeps text extraction as the default', () => {
        const printPlan = findWindowsHostOraclePlan('WIN-PRINT-01');
        expect(printPlan?.pdfTargets.map(target => target.pageMarkerMode)).toEqual([
            'ocr',
            'ocr',
        ]);

        const textPlan = windowsHostOraclePlans.find(plan => plan.caseId === 'WIN-PRINT-02');
        expect(textPlan).toBeDefined();
        expect(textPlan!.pdfTargets.every(target => target.pageMarkerMode === undefined)).toBe(true);
    });

    it('rejects OCR on a lookalike artifact path outside the exact print targets', () => {
        const basePlan = windowsHostOraclePlans.find(plan => plan.caseId === 'WIN-PRINT-01');
        expect(basePlan).toBeDefined();
        const errors = validateWindowsHostOraclePlan({
            ...basePlan!,
            pdfTargets: [{
                ...basePlan!.pdfTargets[0]!,
                artifactPath: 'staged/WIN-PRINT-01/cold.pdf',
                pageMarkerMode: 'ocr',
            }],
        });

        expect(errors).toContain('Case WIN-PRINT-01 uses OCR page markers outside the WIN-PRINT-01 cold and warm print targets.');
    });

    it('fails closed when a target carries an expectation without its oracle', () => {
        const basePlan = windowsHostOraclePlans.find(plan => plan.caseId === 'WIN-SAVE-01');
        expect(basePlan).toBeDefined();
        const target = basePlan!.pdfTargets[0];
        expect(target).toBeDefined();
        const errors = validateWindowsHostOraclePlan({
            ...basePlan!,
            pdfTargets: [{
                ...target!,
                structure: {
                    pageCount: 10,
                    pageGeometry: [],
                },
            }],
        });

        expect(errors).toContain('Case WIN-SAVE-01 has an unused PDF structure expectation for artifacts/WIN-SAVE-01/source-after.pdf.');
    });

    it('fails closed when a plan names an unsupported host oracle', () => {
        const basePlan = windowsHostOraclePlans.find(plan => plan.caseId === 'WIN-PRINT-01');
        expect(basePlan).toBeDefined();
        const errors = validateWindowsHostOraclePlan({
            ...basePlan!,
            hostOracleIds: [
                ...basePlan!.hostOracleIds,
                'future-unimplemented-oracle',
            ],
        });

        expect(errors).toContain('Case WIN-PRINT-01 requires unknown host oracle future-unimplemented-oracle.');
    });

    it('fails closed when a registered host oracle has no dispatcher implementation', () => {
        const basePlan = windowsHostOraclePlans.find(plan => plan.caseId === 'WIN-PRINT-01');
        expect(basePlan).toBeDefined();
        const errors = validateWindowsHostOraclePlan({
            ...basePlan!,
            hostOracleIds: [
                ...basePlan!.hostOracleIds,
                'human-review',
            ],
        });

        expect(errors).toContain('Case WIN-PRINT-01 requires host oracle human-review, but this dispatcher has no implementation for it.');
    });
});
