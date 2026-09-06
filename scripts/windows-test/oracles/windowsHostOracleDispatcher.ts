import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
    IWindowsTestResult,
    TWindowsTestOutcome,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {combineOutcomes} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    NUMBERED_FIXTURE_PAGE_COUNT,
    numberedFixtureMarkers,
} from '@scripts/windows-test/fixtures/generateNumberedFixture';
import {METADATA_FIXTURE_PAGE_COUNT} from '@scripts/windows-test/fixtures/generateMetadataFixture';
import {findOracleDescriptor} from '@scripts/windows-test/oracles/oracleRegistry';
import {getErrorMessage} from '@contracts/getErrorMessage';
import type { TOcrProcessRunner } from '@scripts/windows-test/oracles/ocrPageMarkerOracle';
import {
    combineOracleStatuses,
    type IOracleResult,
    type TOracleStatus,
} from '@scripts/windows-test/oracles/oracleResult';
import {evaluatePageMarkers} from '@scripts/windows-test/oracles/pageMarkerOracle';
import {
    evaluatePageCount,
    evaluatePdfStructure,
    type IPdfPageGeometry,
    type IPdfStructureExpectation,
} from '@scripts/windows-test/oracles/pdfStructureOracle';
import {
    evaluateRenderNonBlank,
    type IRenderBlankExpectation,
} from '@scripts/windows-test/oracles/renderBlankOracle';
import {evaluateSourceIsolation} from '@scripts/windows-test/oracles/sourceIsolationOracle';
import {
    runVerifyGeneratedPdf,
    type IVerifyProcessResult,
    type TVerifyProcessRunner,
} from '@scripts/windows-test/oracles/verifyGeneratedPdfWrapper';

export const WINDOWS_HOST_ORACLE_DISPATCHER_VERSION = 'windows-host-oracles@2';

export const WINDOWS_HOST_ORACLE_RESULTS_FILE = 'oracle-results.json';

export interface IWindowsHostOracleTarget {
    artifactPath: string;
    oracleIds: readonly string[];
    expectedPageCount?: number;
    expectedMarkers?: readonly string[];
    pageMarkerMode?: 'text' | 'ocr';
    structure?: IPdfStructureExpectation;
    render?: Omit<IRenderBlankExpectation, 'repositoryRoot'>;
    verifier?: {
        pages?: readonly number[];
        dpi?: number;
        allowLarge?: boolean;
    };
}

export interface IWindowsHostSourceIsolationTarget {
    baselineArtifactPath: string;
    finalArtifactPath: string;
    sourceMustChange?: boolean;
    expectedSidecarFiles?: readonly string[];
    forbiddenResidueFiles?: readonly string[];
}

export interface IWindowsHostOraclePlan {
    caseId: string;
    /** Every file must be present in the manifest-covered evidence directory. */
    requiredArtifactPaths: readonly string[];
    /** This list mirrors the host-side IDs declared in capabilities.json. */
    hostOracleIds: readonly string[];
    pdfTargets: readonly IWindowsHostOracleTarget[];
    sourceIsolation?: IWindowsHostSourceIsolationTarget;
}

export interface IWindowsHostOracleResult extends IOracleResult {
    caseId: string;
    artifactPath: string | null;
    side: 'host';
    provenance: string;
}

export interface IWindowsHostOracleReport {
    schemaVersion: 1;
    dispatcherVersion: string;
    runId: string;
    environmentId: string;
    status: TOracleStatus;
    outcome: TWindowsTestOutcome;
    humanReviewRequired: boolean;
    results: readonly IWindowsHostOracleResult[];
    errors: readonly string[];
    skippedCaseIds: readonly string[];
}

export interface IWindowsHostOracleDispatchInput {
    runId: string;
    environmentId: string;
    repositoryRoot: string;
    evidenceDirectory: string;
    /** The coordinator passes runDir/oracle-results.json here. */
    resultsFile: string;
    result: IWindowsTestResult;
    /** Tests can supply a deterministic process runner; production uses Python. */
    verifyProcessRunner?: TVerifyProcessRunner;
    /** Tests can supply deterministic OCR output; production invokes host tesseract. */
    ocrProcessRunner?: TOcrProcessRunner;
}

export interface IWindowsHostOracleDispatchResult {
    outcome: TWindowsTestOutcome;
    status: TOracleStatus;
    results: readonly IWindowsHostOracleResult[];
    resultsFile: string;
    humanReviewRequired: boolean;
    errors: readonly string[];
    skippedCaseIds: readonly string[];
}

const NUMBERED_PAGE_GEOMETRY: readonly IPdfPageGeometry[] = Array.from(
    { length: NUMBERED_FIXTURE_PAGE_COUNT },
    () => ({
        width: 595.28,
        height: 841.89,
        rotation: 0,
    }),
);

function numberedSurvivorMarkers() {
    return numberedFixtureMarkers().filter((_marker, index) => index + 1 !== 3 && index + 1 !== 6);
}

function numberedSurvivorGeometry() {
    return NUMBERED_PAGE_GEOMETRY.filter((_geometry, index) => index + 1 !== 3 && index + 1 !== 6);
}

function structure(pageCount: number, pageGeometry: readonly IPdfPageGeometry[]): IPdfStructureExpectation {
    return {
        pageCount,
        pageGeometry,
    };
}

/**
 * The plan is deliberately static. Expectations live on the host and cannot
 * be supplied by the guest result or by a summary written by the app under
 * test. Planned catalogue rows have no entry here and are recorded as skipped.
 */
export const windowsHostOraclePlans: readonly IWindowsHostOraclePlan[] = [
    {
        caseId: 'WIN-PRINT-01',
        requiredArtifactPaths: [
            'artifacts/WIN-PRINT-01/source.pdf',
            'artifacts/WIN-PRINT-01/cold.pdf',
            'artifacts/WIN-PRINT-01/warm.pdf',
        ],
        hostOracleIds: [
            'page-count',
            'page-markers',
            'pdf-structure',
            'render-nonblank',
            'generated-pdf-verifier',
        ],
        pdfTargets: [
            {
                artifactPath: 'artifacts/WIN-PRINT-01/cold.pdf',
                oracleIds: [
                    'page-count',
                    'page-markers',
                    'pdf-structure',
                    'render-nonblank',
                    'generated-pdf-verifier',
                ],
                expectedPageCount: NUMBERED_FIXTURE_PAGE_COUNT,
                expectedMarkers: numberedFixtureMarkers(),
                pageMarkerMode: 'ocr',
                structure: structure(NUMBERED_FIXTURE_PAGE_COUNT, NUMBERED_PAGE_GEOMETRY),
            },
            {
                artifactPath: 'artifacts/WIN-PRINT-01/warm.pdf',
                oracleIds: [
                    'page-count',
                    'page-markers',
                    'pdf-structure',
                    'render-nonblank',
                    'generated-pdf-verifier',
                ],
                expectedPageCount: NUMBERED_FIXTURE_PAGE_COUNT,
                expectedMarkers: numberedFixtureMarkers(),
                pageMarkerMode: 'ocr',
                structure: structure(NUMBERED_FIXTURE_PAGE_COUNT, NUMBERED_PAGE_GEOMETRY),
            },
        ],
    },
    {
        caseId: 'WIN-PRINT-02',
        requiredArtifactPaths: [
            'artifacts/WIN-PRINT-02/source-before.pdf',
            'artifacts/WIN-PRINT-02/source-after.pdf',
            'artifacts/WIN-PRINT-02/printed.pdf',
        ],
        hostOracleIds: [
            'page-count',
            'page-markers',
            'pdf-structure',
            'source-isolation',
        ],
        pdfTargets: [{
            artifactPath: 'artifacts/WIN-PRINT-02/printed.pdf',
            oracleIds: [
                'page-count',
                'page-markers',
                'pdf-structure',
            ],
            expectedPageCount: NUMBERED_FIXTURE_PAGE_COUNT - 2,
            expectedMarkers: numberedSurvivorMarkers(),
            structure: structure(NUMBERED_FIXTURE_PAGE_COUNT - 2, numberedSurvivorGeometry()),
        }],
        sourceIsolation: {
            baselineArtifactPath: 'artifacts/WIN-PRINT-02/source-before.pdf',
            finalArtifactPath: 'artifacts/WIN-PRINT-02/source-after.pdf',
            sourceMustChange: true,
        },
    },
    {
        caseId: 'WIN-PRINT-07',
        requiredArtifactPaths: [
            'artifacts/WIN-PRINT-07/source.pdf',
            'artifacts/WIN-PRINT-07/source-after.pdf',
            'artifacts/WIN-PRINT-07/protected.pdf',
        ],
        hostOracleIds: ['source-isolation'],
        pdfTargets: [],
        sourceIsolation: {
            baselineArtifactPath: 'artifacts/WIN-PRINT-07/source.pdf',
            finalArtifactPath: 'artifacts/WIN-PRINT-07/source-after.pdf',
        },
    },
    {
        caseId: 'WIN-SAVE-01',
        requiredArtifactPaths: [
            'artifacts/WIN-SAVE-01/source-before.pdf',
            'artifacts/WIN-SAVE-01/source-after.pdf',
        ],
        hostOracleIds: [
            'page-count',
            'page-markers',
            'source-isolation',
        ],
        pdfTargets: [{
            artifactPath: 'artifacts/WIN-SAVE-01/source-after.pdf',
            oracleIds: [
                'page-count',
                'page-markers',
            ],
            expectedPageCount: NUMBERED_FIXTURE_PAGE_COUNT - 2,
            expectedMarkers: numberedSurvivorMarkers(),
        }],
        sourceIsolation: {
            baselineArtifactPath: 'artifacts/WIN-SAVE-01/source-before.pdf',
            finalArtifactPath: 'artifacts/WIN-SAVE-01/source-after.pdf',
            sourceMustChange: true,
        },
    },
    {
        caseId: 'WIN-SAVE-02',
        requiredArtifactPaths: [
            'artifacts/WIN-SAVE-02/source-before.pdf',
            'artifacts/WIN-SAVE-02/source-after.pdf',
            'artifacts/WIN-SAVE-02/target.pdf',
        ],
        hostOracleIds: [
            'pdf-structure',
            'source-isolation',
        ],
        pdfTargets: [{
            artifactPath: 'artifacts/WIN-SAVE-02/target.pdf',
            oracleIds: ['pdf-structure'],
            structure: structure(METADATA_FIXTURE_PAGE_COUNT, Array.from(
                { length: METADATA_FIXTURE_PAGE_COUNT },
                () => ({
                    width: 595.28,
                    height: 841.89,
                    rotation: 0,
                }),
            )),
        }],
        sourceIsolation: {
            baselineArtifactPath: 'artifacts/WIN-SAVE-02/source-before.pdf',
            finalArtifactPath: 'artifacts/WIN-SAVE-02/source-after.pdf',
        },
    },
    {
        caseId: 'WIN-SAVE-04',
        requiredArtifactPaths: [
            'artifacts/WIN-SAVE-04/source-before.pdf',
            'artifacts/WIN-SAVE-04/source-after.pdf',
        ],
        hostOracleIds: ['source-isolation'],
        pdfTargets: [],
        sourceIsolation: {
            baselineArtifactPath: 'artifacts/WIN-SAVE-04/source-before.pdf',
            finalArtifactPath: 'artifacts/WIN-SAVE-04/source-after.pdf',
            sourceMustChange: true,
        },
    },
    {
        caseId: 'WIN-SAVE-08',
        requiredArtifactPaths: [
            'artifacts/WIN-SAVE-08/source-before.pdf',
            'artifacts/WIN-SAVE-08/source-after.pdf',
            'artifacts/WIN-SAVE-08/revision-sidecar.json',
        ],
        hostOracleIds: [],
        pdfTargets: [],
    },
    {
        caseId: 'WIN-UI-02',
        requiredArtifactPaths: [
            'artifacts/WIN-UI-02/source.pdf',
            'artifacts/WIN-UI-02/target.pdf',
        ],
        hostOracleIds: [],
        pdfTargets: [],
    },
];

const PLANS_BY_CASE_ID = new Map(windowsHostOraclePlans.map(plan => [
    plan.caseId,
    plan,
]));

const IMPLEMENTED_HOST_ORACLE_IDS = new Set([
    'page-count',
    'page-markers',
    'pdf-structure',
    'render-nonblank',
    'generated-pdf-verifier',
    'source-isolation',
]);

function defaultVerifierRunner(
    command: string,
    args: readonly string[],
): Promise<IVerifyProcessResult> {
    const environment = { ...process.env };
    // The parent may be an Electron process. Its marker must never leak into
    // the Python verifier, or the interpreter can enter Electron's node mode.
    delete environment.ELECTRON_RUN_AS_NODE;
    return new Promise(resolve => {
        execFile(command, [...args], {
            env: environment,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 300_000,
            killSignal: 'SIGTERM',
            windowsHide: true,
        }, (error, stdout, stderr) => {
            resolve({
                exitCode: error === null
                    ? 0
                    : typeof error.code === 'number' ? error.code : 1,
                stdout,
                stderr,
            });
        });
    });
}

function isSafeRelativeArtifactPath(relativePath: string) {
    const normalized = relativePath.replaceAll('\\', '/');
    return normalized.length > 0
        && !normalized.startsWith('/')
        && !/^[A-Za-z]:/u.test(normalized)
        && normalized.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function resolveArtifactPath(evidenceDirectory: string, relativePath: string) {
    if (!isSafeRelativeArtifactPath(relativePath)) {
        return null;
    }
    const root = path.resolve(evidenceDirectory);
    const absolute = path.resolve(root, ...relativePath.replaceAll('\\', '/').split('/'));
    return absolute === root || absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

async function artifactExists(absolutePath: string) {
    return (await stat(absolutePath).catch(() => null)) !== null;
}

function decorateResult(
    caseId: string,
    artifactPath: string | null,
    result: IOracleResult,
): IWindowsHostOracleResult {
    const descriptor = findOracleDescriptor(result.oracleId);
    return {
        ...result,
        caseId,
        artifactPath,
        side: 'host',
        provenance: descriptor?.provenance ?? 'unregistered oracle',
    };
}

function unsupportedOracleError(caseId: string, oracleId: string) {
    const descriptor = findOracleDescriptor(oracleId);
    if (descriptor === null) {
        return `Case ${caseId} requires unknown host oracle ${oracleId}.`;
    }
    if (descriptor.side !== 'host') {
        return `Case ${caseId} requires ${oracleId}, which is a guest oracle and cannot run on the host.`;
    }
    return `Case ${caseId} requires host oracle ${oracleId}, but this dispatcher has no implementation for it.`;
}

function checkPlanShape(plan: IWindowsHostOraclePlan) {
    const errors: string[] = [];
    const declared = new Set(plan.hostOracleIds);
    const used = new Set<string>();
    const required = new Set(plan.requiredArtifactPaths);
    for (const relativePath of plan.requiredArtifactPaths) {
        if (!isSafeRelativeArtifactPath(relativePath)) {
            errors.push(`Case ${plan.caseId} declares unsafe required artifact path ${relativePath}.`);
        }
    }
    for (const target of plan.pdfTargets) {
        if (!required.has(target.artifactPath)) {
            errors.push(`Case ${plan.caseId} does not require PDF artifact ${target.artifactPath}.`);
        }
        for (const oracleId of target.oracleIds) {
            used.add(oracleId);
            if (!declared.has(oracleId)) {
                errors.push(`Case ${plan.caseId} uses undeclared host oracle ${oracleId}.`);
            }
        }
    }
    if (plan.sourceIsolation !== undefined) {
        if (!required.has(plan.sourceIsolation.baselineArtifactPath)) {
            errors.push(`Case ${plan.caseId} does not require source baseline ${plan.sourceIsolation.baselineArtifactPath}.`);
        }
        if (!required.has(plan.sourceIsolation.finalArtifactPath)) {
            errors.push(`Case ${plan.caseId} does not require final source artifact ${plan.sourceIsolation.finalArtifactPath}.`);
        }
        used.add('source-isolation');
        if (!declared.has('source-isolation')) {
            errors.push(`Case ${plan.caseId} uses undeclared host oracle source-isolation.`);
        }
    }
    for (const oracleId of declared) {
        if (!used.has(oracleId)) {
            errors.push(`Case ${plan.caseId} declares host oracle ${oracleId} without a target.`);
        }
        const descriptor = findOracleDescriptor(oracleId);
        if (descriptor === null || descriptor.side !== 'host') {
            errors.push(unsupportedOracleError(plan.caseId, oracleId));
        } else if (!IMPLEMENTED_HOST_ORACLE_IDS.has(oracleId)) {
            errors.push(unsupportedOracleError(plan.caseId, oracleId));
        }
    }
    return errors;
}

function appendInvalidExpectationErrors(
    plan: IWindowsHostOraclePlan,
    errors: string[],
) {
    for (const target of plan.pdfTargets) {
        const oracleIds = new Set(target.oracleIds);
        if (target.expectedPageCount !== undefined && !oracleIds.has('page-count')) {
            errors.push(`Case ${plan.caseId} has an unused page-count expectation for ${target.artifactPath}.`);
        }
        if (target.expectedMarkers !== undefined && !oracleIds.has('page-markers')) {
            errors.push(`Case ${plan.caseId} has unused page-marker expectations for ${target.artifactPath}.`);
        }
        const isAllowedOcrTarget = plan.caseId === 'WIN-PRINT-01'
            && (target.artifactPath === 'artifacts/WIN-PRINT-01/cold.pdf'
                || target.artifactPath === 'artifacts/WIN-PRINT-01/warm.pdf');
        if (target.pageMarkerMode === 'ocr' && !isAllowedOcrTarget) {
            errors.push(`Case ${plan.caseId} uses OCR page markers outside the WIN-PRINT-01 cold and warm print targets.`);
        }
        if (target.structure !== undefined && !oracleIds.has('pdf-structure')) {
            errors.push(`Case ${plan.caseId} has an unused PDF structure expectation for ${target.artifactPath}.`);
        }
        if (target.render !== undefined && !oracleIds.has('render-nonblank')) {
            errors.push(`Case ${plan.caseId} has an unused render expectation for ${target.artifactPath}.`);
        }
        if (target.verifier !== undefined && !oracleIds.has('generated-pdf-verifier')) {
            errors.push(`Case ${plan.caseId} has an unused verifier expectation for ${target.artifactPath}.`);
        }
        if (oracleIds.has('page-count') && target.expectedPageCount === undefined) {
            errors.push(`Case ${plan.caseId} has no page-count expectation for ${target.artifactPath}.`);
        }
        if (oracleIds.has('page-markers')
            && (target.expectedMarkers === undefined || target.expectedMarkers.length === 0)) {
            errors.push(`Case ${plan.caseId} has no page-marker expectation for ${target.artifactPath}.`);
        }
        if (oracleIds.has('pdf-structure') && target.structure === undefined) {
            errors.push(`Case ${plan.caseId} has no PDF structure expectation for ${target.artifactPath}.`);
        }
        if (oracleIds.has('render-nonblank') && target.render === undefined) {
            // The renderer's defaults are deterministic, so an omitted object
            // is valid for this oracle. Keep this branch for future strictness.
        }
        if (oracleIds.has('generated-pdf-verifier') && target.verifier === undefined) {
            // The tracked verifier's default options are part of the plan.
        }
    }
}

export function validateWindowsHostOraclePlan(plan: IWindowsHostOraclePlan) {
    const errors = checkPlanShape(plan);
    appendInvalidExpectationErrors(plan, errors);
    return errors;
}

async function evaluatePdfTarget(
    input: IWindowsHostOracleDispatchInput,
    plan: IWindowsHostOraclePlan,
    target: IWindowsHostOracleTarget,
    absolutePath: string,
    results: IWindowsHostOracleResult[],
) {
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await readFile(absolutePath));
    } catch (error) {
        return [`Case ${plan.caseId} artifact ${target.artifactPath} could not be read: ${getErrorMessage(error)}.`];
    }
    const oracleIds = new Set(target.oracleIds);
    if (oracleIds.has('page-count')) {
        results.push(decorateResult(
            plan.caseId,
            target.artifactPath,
            await evaluatePageCount(bytes, target.expectedPageCount!),
        ));
    }
    if (oracleIds.has('page-markers')) {
        results.push(decorateResult(
            plan.caseId,
            target.artifactPath,
            await evaluatePageMarkers(bytes, {
                repositoryRoot: input.repositoryRoot,
                expectedMarkers: target.expectedMarkers!,
                ...(target.pageMarkerMode === undefined ? {} : {mode: target.pageMarkerMode}),
                ...(input.ocrProcessRunner === undefined ? {} : {processRunner: input.ocrProcessRunner}),
            }),
        ));
    }
    if (oracleIds.has('pdf-structure')) {
        results.push(decorateResult(
            plan.caseId,
            target.artifactPath,
            await evaluatePdfStructure(bytes, target.structure!),
        ));
    }
    if (oracleIds.has('render-nonblank')) {
        results.push(decorateResult(
            plan.caseId,
            target.artifactPath,
            await evaluateRenderNonBlank(bytes, {
                repositoryRoot: input.repositoryRoot,
                ...target.render,
            }),
        ));
    }
    if (oracleIds.has('generated-pdf-verifier')) {
        results.push(decorateResult(
            plan.caseId,
            target.artifactPath,
            await runVerifyGeneratedPdf({
                repositoryRoot: input.repositoryRoot,
                pdfPath: absolutePath,
                artifactDirectory: path.dirname(absolutePath),
                ...target.verifier,
                runner: input.verifyProcessRunner ?? defaultVerifierRunner,
            }),
        ));
    }
    return [];
}

async function evaluateSourceIsolationTarget(
    plan: IWindowsHostOraclePlan,
    target: IWindowsHostSourceIsolationTarget,
    evidenceDirectory: string,
    results: IWindowsHostOracleResult[],
) {
    const baselinePath = resolveArtifactPath(evidenceDirectory, target.baselineArtifactPath);
    const finalPath = resolveArtifactPath(evidenceDirectory, target.finalArtifactPath);
    if (baselinePath === null || finalPath === null) {
        return [`Case ${plan.caseId} has an unsafe source-isolation artifact path.`];
    }
    if (!await artifactExists(baselinePath)) {
        return [`Case ${plan.caseId} is missing source baseline ${target.baselineArtifactPath}.`];
    }
    if (!await artifactExists(finalPath)) {
        return [`Case ${plan.caseId} is missing final source artifact ${target.finalArtifactPath}.`];
    }
    let expectedSourceSha256: string;
    try {
        const baseline = new Uint8Array(await readFile(baselinePath));
        expectedSourceSha256 = createHash('sha256').update(baseline).digest('hex');
    } catch (error) {
        return [`Case ${plan.caseId} could not hash source baseline ${target.baselineArtifactPath}: ${getErrorMessage(error)}.`];
    }
    const expectation = {
        expectedSourceSha256,
        ...(target.sourceMustChange === undefined ? {} : { sourceMustChange: target.sourceMustChange }),
        ...(target.expectedSidecarFiles === undefined ? {} : { expectedSidecarFiles: target.expectedSidecarFiles }),
        ...(target.forbiddenResidueFiles === undefined ? {} : { forbiddenResidueFiles: target.forbiddenResidueFiles }),
    };
    results.push(decorateResult(
        plan.caseId,
        target.finalArtifactPath,
        await evaluateSourceIsolation({
            sourcePath: finalPath,
            workingDirectory: path.dirname(finalPath),
        }, expectation),
    ));
    return [];
}

function outcomeForOracleRun(
    results: readonly IWindowsHostOracleResult[],
    errors: readonly string[],
): TWindowsTestOutcome {
    let outcome: TWindowsTestOutcome = errors.length > 0 ? 'infrastructure-failed' : 'passed';
    for (const result of results) {
        if (result.oracleId === 'human-review') {
            continue;
        }
        if (result.status === 'failed') {
            outcome = combineOutcomes(outcome, 'product-failed');
        } else if (result.status === 'inconclusive') {
            outcome = combineOutcomes(outcome, 'infrastructure-failed');
        }
    }
    return outcome;
}

function statusForOracleRun(
    results: readonly IWindowsHostOracleResult[],
    errors: readonly string[],
): TOracleStatus {
    const automatedStatuses = results
        .filter(result => result.oracleId !== 'human-review')
        .map(result => result.status);
    if (errors.length > 0) {
        automatedStatuses.push('inconclusive');
    }
    return automatedStatuses.length === 0 ? 'passed' : combineOracleStatuses(automatedStatuses);
}

export async function runWindowsHostOracles(
    input: IWindowsHostOracleDispatchInput,
): Promise<IWindowsHostOracleDispatchResult> {
    const errors: string[] = [];
    const results: IWindowsHostOracleResult[] = [];
    const skippedCaseIds: string[] = [];
    const selectedPlans = new Set<string>();

    for (const expectedCaseId of input.result.expectedTests) {
        const plan = PLANS_BY_CASE_ID.get(expectedCaseId);
        if (plan === undefined) {
            continue;
        }
        if (selectedPlans.has(expectedCaseId)) {
            continue;
        }
        selectedPlans.add(expectedCaseId);
        const caseResult = input.result.cases.find(candidate => candidate.testId === expectedCaseId);
        if (caseResult === undefined) {
            errors.push(`The guest result omitted implemented case ${expectedCaseId}.`);
            continue;
        }
        const planErrors = validateWindowsHostOraclePlan(plan);
        errors.push(...planErrors);
        if (planErrors.length > 0) {
            continue;
        }
        for (const relativePath of plan.requiredArtifactPaths) {
            const absolutePath = resolveArtifactPath(input.evidenceDirectory, relativePath);
            if (absolutePath === null) {
                errors.push(`Case ${plan.caseId} declares unsafe evidence path ${relativePath}.`);
                continue;
            }
            if (!await artifactExists(absolutePath)) {
                errors.push(`Case ${plan.caseId} is missing required evidence artifact ${relativePath}.`);
            }
        }

        for (const target of plan.pdfTargets) {
            const absolutePath = resolveArtifactPath(input.evidenceDirectory, target.artifactPath);
            if (absolutePath === null) {
                errors.push(`Case ${plan.caseId} declares unsafe PDF artifact path ${target.artifactPath}.`);
                continue;
            }
            if (!await artifactExists(absolutePath)) {
                continue;
            }
            errors.push(...await evaluatePdfTarget(input, plan, target, absolutePath, results));
        }
        if (plan.sourceIsolation !== undefined) {
            const sourceErrors = await evaluateSourceIsolationTarget(
                plan,
                plan.sourceIsolation,
                input.evidenceDirectory,
                results,
            );
            errors.push(...sourceErrors);
        }
    }
    for (const caseResult of input.result.cases) {
        if (!selectedPlans.has(caseResult.testId)) {
            skippedCaseIds.push(caseResult.testId);
        }
    }

    const humanReviewRequired = results.some(result => result.oracleId === 'human-review')
        || input.result.humanReviewRequired;
    const status = statusForOracleRun(results, errors);
    const outcome = outcomeForOracleRun(results, errors);
    const report: IWindowsHostOracleReport = {
        schemaVersion: 1,
        dispatcherVersion: WINDOWS_HOST_ORACLE_DISPATCHER_VERSION,
        runId: input.runId,
        environmentId: input.environmentId,
        status,
        outcome,
        humanReviewRequired,
        results,
        errors,
        skippedCaseIds,
    };
    await mkdir(path.dirname(input.resultsFile), { recursive: true });
    await writeFile(input.resultsFile, `${JSON.stringify(report, null, 4)}\n`, 'utf8');
    return {
        outcome,
        status,
        results,
        resultsFile: input.resultsFile,
        humanReviewRequired,
        errors,
        skippedCaseIds,
    };
}

/** Used by registry parity tests and by the coordinator's integration hook. */
export function findWindowsHostOraclePlan(caseId: string) {
    return PLANS_BY_CASE_ID.get(caseId) ?? null;
}
