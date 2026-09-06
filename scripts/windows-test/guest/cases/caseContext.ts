import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    combineOutcomes,
    type IWindowsTestAssertionResult,
    type IWindowsTestCaseResult,
    type TWindowsTestCaseStatus,
    type TWindowsTestDriver,
    type TWindowsTestOutcome,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IGuestRunPaths } from '@scripts/windows-test/guest/guestPaths';
import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';
import type {
    IGuestClock,
    IGuestCommandRunner,
    IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    GuestPowerShellScriptError,
    type IGuestPowerShellRunner,
} from '@scripts/windows-test/guest/guestPowerShell';
import {
    AmbiguousSelectorError,
    DesktopUnavailableError,
    SelectorNotFoundError,
    type INativeUiAdapter,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import type { IUiSelectorRecordFile } from '@scripts/windows-test/guest/native-ui/selectorRecords';
import type { IViewerFactory } from '@scripts/windows-test/guest/viewer/viewerDriver';

export type TCaseActionKind = IWindowsTestCaseResult['actionKind'];

export class NotYetImplementedStep extends Error {
    constructor(public readonly step: string, public readonly blocker: string) {
        super(`Step "${step}" has no implementation yet: ${blocker}`);
        this.name = 'NotYetImplementedStep';
    }
}

export class CaseAssertionFailedError extends Error {
    constructor(public readonly assertionId: string, detail: string) {
        super(`Assertion ${assertionId} failed: ${detail}`);
        this.name = 'CaseAssertionFailedError';
    }
}

export class CaseCanceledError extends Error {
    constructor() {
        super('The run was canceled before the case finished');
        this.name = 'CaseCanceledError';
    }
}

export class CaseDeadlineError extends Error {
    constructor(public readonly remainingMs: number) {
        super(`The job deadline expired with ${remainingMs}ms remaining`);
        this.name = 'CaseDeadlineError';
    }
}

export interface ICaseEnvironment {
    clock: IGuestClock;
    fs: IGuestFileSystem;
    exec: IGuestCommandRunner;
    powerShell: IGuestPowerShellRunner;
    nativeUi: INativeUiAdapter;
    viewer: IViewerFactory;
    selectors: IUiSelectorRecordFile;
    paths: IGuestRunPaths;
    separator: string;
    installDirectory: string;
    fixturePath(fixtureId: string): string;
    log(message: string): void;
    throwIfCanceled(): Promise<void>;
    remainingMs(): number;
}

export interface ICaseContext extends ICaseEnvironment {
    testId: string;
    assert(assertionId: string, passed: boolean, detail: string): void;
    requireAssertion(assertionId: string, passed: boolean, detail: string): void;
    outputPath(fileName: string): string;
    evidencePath(fileName: string): string;
    attachEvidence(fileName: string): string;
    /** Copy a binary artifact into the manifest-covered evidence tree. */
    captureArtifact(sourcePath: string, fileName: string): Promise<string>;
    assertions(): IWindowsTestAssertionResult[];
    collectedEvidence(): string[];
}

export interface ICaseDefinition {
    id: string;
    family: string;
    driver: TWindowsTestDriver;
    ledgerDrivers: string;
    actionKind: TCaseActionKind;
    status: TWindowsTestCaseStatus;
    run(context: ICaseContext): Promise<void>;
}

export function createCaseContext(testId: string, environment: ICaseEnvironment): ICaseContext {
    const assertions: IWindowsTestAssertionResult[] = [];
    const evidenceFiles: string[] = [];
    const record = (assertionId: string, passed: boolean, detail: string) => {
        assertions.push({
            id: assertionId,
            passed,
            detail,
        });
    };
    const normalizeEvidencePath = (fileName: string) => {
        const normalized = fileName.replaceAll('\\', '/');
        const segments = normalized.split('/');
        if (normalized.length === 0
            || normalized.startsWith('/')
            || /^[A-Za-z]:/u.test(normalized)
            || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
            throw new Error(`Evidence path must be a safe relative file name: ${fileName}`);
        }
        return segments.join('/');
    };
    const absoluteEvidencePath = (fileName: string) => joinGuestPath(
        environment.separator,
        environment.paths.evidenceDir,
        ...normalizeEvidencePath(fileName).split('/'),
    );

    return {
        ...environment,
        testId,
        assert: record,
        requireAssertion: (assertionId, passed, detail) => {
            record(assertionId, passed, detail);
            if (!passed) {
                throw new CaseAssertionFailedError(assertionId, detail);
            }
        },
        outputPath: fileName => joinGuestPath(environment.separator, environment.paths.outputsDir, fileName),
        evidencePath: absoluteEvidencePath,
        attachEvidence: (fileName) => {
            const relativePath = normalizeEvidencePath(fileName);
            if (!evidenceFiles.includes(relativePath)) {
                evidenceFiles.push(relativePath);
            }
            return absoluteEvidencePath(relativePath);
        },
        captureArtifact: async (sourcePath, fileName) => {
            const relativePath = normalizeEvidencePath(fileName);
            const targetPath = absoluteEvidencePath(relativePath);
            await environment.fs.makeDirectory(environment.paths.evidenceDir);
            const parentSegments = relativePath.split('/').slice(0, -1);
            if (parentSegments.length > 0) {
                await environment.fs.makeDirectory(joinGuestPath(
                    environment.separator,
                    environment.paths.evidenceDir,
                    ...parentSegments,
                ));
            }
            await environment.fs.copyFile(sourcePath, targetPath);
            if (!evidenceFiles.includes(relativePath)) {
                evidenceFiles.push(relativePath);
            }
            return targetPath;
        },
        assertions: () => [...assertions],
        collectedEvidence: () => [...evidenceFiles],
    };
}

function outcomeForError(error: unknown): {
    outcome: TWindowsTestOutcome;
    reason: string;
} {
    if (error instanceof CaseCanceledError) {
        return {
            outcome: 'canceled',
            reason: error.message,
        };
    }
    if (error instanceof NotYetImplementedStep) {
        return {
            outcome: 'unsupported',
            reason: error.message,
        };
    }
    if (error instanceof CaseAssertionFailedError) {
        return {
            outcome: 'product-failed',
            reason: error.message,
        };
    }
    if (error instanceof DesktopUnavailableError
        || error instanceof AmbiguousSelectorError
        || error instanceof SelectorNotFoundError
        || error instanceof GuestPowerShellScriptError
        || error instanceof CaseDeadlineError) {
        return {
            outcome: 'infrastructure-failed',
            reason: error.message,
        };
    }
    return {
        outcome: 'infrastructure-failed',
        reason: getErrorMessage(error),
    };
}

function outcomeForAssertions(assertions: readonly IWindowsTestAssertionResult[]) {
    if (assertions.some(assertion => !assertion.passed)) {
        return 'product-failed' as const;
    }
    return assertions.length === 0 ? 'unsupported' as const : 'passed' as const;
}

export async function runRegisteredCase(
    definition: ICaseDefinition,
    environment: ICaseEnvironment,
): Promise<IWindowsTestCaseResult> {
    const context = createCaseContext(definition.id, environment);
    const startedAt = environment.clock.nowIso();
    let outcome: TWindowsTestOutcome = 'passed';
    let failureReason: string | null = null;

    if (definition.status !== 'implemented') {
        return {
            testId: definition.id,
            driver: definition.driver,
            actionKind: definition.actionKind,
            outcome: 'unsupported',
            startedAt,
            endedAt: environment.clock.nowIso(),
            assertions: [],
            evidenceFiles: [],
            failureReason: `Case ${definition.id} is registered as ${definition.status}`,
        };
    }

    try {
        await definition.run(context);
    } catch (error) {
        const mapped = outcomeForError(error);
        outcome = mapped.outcome;
        failureReason = mapped.reason;
    }

    const assertions = context.assertions();
    const assertionOutcome = outcomeForAssertions(assertions);
    const combined = failureReason === null
        ? assertionOutcome
        : combineOutcomes(outcome, assertionOutcome);
    if (combined === 'unsupported' && failureReason === null) {
        failureReason = 'The case finished without recording a single assertion';
    }

    return {
        testId: definition.id,
        driver: definition.driver,
        actionKind: definition.actionKind,
        outcome: combined,
        startedAt,
        endedAt: environment.clock.nowIso(),
        assertions,
        evidenceFiles: context.collectedEvidence(),
        failureReason: combined === 'passed' ? null : failureReason,
    };
}
