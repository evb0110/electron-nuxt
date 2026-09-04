import { isWindowsTestId } from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsCapabilityCase,
    IWindowsCapabilityRegistry,
} from '@scripts/windows-test/registry/capabilityRegistry';

export interface IRegistryLintProblem {
    caseId: string;
    message: string;
}

export interface IRegistryLintResult {
    ok: boolean;
    problems: IRegistryLintProblem[];
}

export interface IRegistryLintOptions {
    knownFixtureIds: readonly string[];
    knownOracleIds: readonly string[];
    implementedCaseIds: readonly string[];
    now?: Date;
}

const REGISTRY_SCOPE = '<registry>';

function checkIdentity(
    capabilityCase: IWindowsCapabilityCase,
    seen: Set<string>,
    problems: IRegistryLintProblem[],
) {
    if (!isWindowsTestId(capabilityCase.id)) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Test ID "${capabilityCase.id}" does not match WIN-[A-Z]+-\\d{2}.`,
        });
    }
    if (seen.has(capabilityCase.id)) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Duplicate test ID "${capabilityCase.id}".`,
        });
    }
    seen.add(capabilityCase.id);
    if (capabilityCase.owner.trim().length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Owner role is empty.',
        });
    }
    if (capabilityCase.negativeControl.trim().length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Negative control description is empty.',
        });
    }
}

function checkReferences(
    capabilityCase: IWindowsCapabilityCase,
    knownEnvironmentIds: Set<string>,
    options: IRegistryLintOptions,
    problems: IRegistryLintProblem[],
) {
    if (capabilityCase.oracles.length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Oracle list is empty.',
        });
    }
    if (capabilityCase.fixtures.length === 0 && capabilityCase.obligation === 'automated') {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Automated case has an empty fixture list.',
        });
    }
    for (const fixtureId of capabilityCase.fixtures) {
        if (!options.knownFixtureIds.includes(fixtureId)) {
            problems.push({
                caseId: capabilityCase.id,
                message: `Unknown fixture ID "${fixtureId}".`,
            });
        }
    }
    for (const oracleId of capabilityCase.oracles) {
        if (!options.knownOracleIds.includes(oracleId)) {
            problems.push({
                caseId: capabilityCase.id,
                message: `Unknown oracle ID "${oracleId}".`,
            });
        }
    }
    for (const environmentId of capabilityCase.environments) {
        if (!knownEnvironmentIds.has(environmentId)) {
            problems.push({
                caseId: capabilityCase.id,
                message: `Unknown environment reference "${environmentId}".`,
            });
        }
    }
    if (!knownEnvironmentIds.has(capabilityCase.primaryEnvironment)) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Unknown primary environment "${capabilityCase.primaryEnvironment}".`,
        });
    }
    if (
        capabilityCase.environments.length > 0
        && !capabilityCase.environments.includes(capabilityCase.primaryEnvironment)
    ) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Primary environment "${capabilityCase.primaryEnvironment}" is missing from the environment list.`,
        });
    }
}

function checkStatusAndGate(
    capabilityCase: IWindowsCapabilityCase,
    options: IRegistryLintOptions,
    problems: IRegistryLintProblem[],
) {
    const skippedStatuses = [
        'planned',
        'quarantined',
        'not-applicable',
        'unsupported-in-environment',
    ];
    if (capabilityCase.gate === 'required' && skippedStatuses.includes(capabilityCase.status)) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Required case is ${capabilityCase.status}; a required gate must reference a case that actually runs.`,
        });
    }
    if (capabilityCase.gate === 'required' && capabilityCase.obligation !== 'automated') {
        problems.push({
            caseId: capabilityCase.id,
            message: `Required case carries a ${capabilityCase.obligation} obligation, which no automated run can close.`,
        });
    }
    if (
        capabilityCase.status === 'implemented'
        && !options.implementedCaseIds.includes(capabilityCase.id)
    ) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Case is marked implemented but no guest case implementation is registered for it.',
        });
    }
    if (capabilityCase.status === 'implemented' && capabilityCase.environments.length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Implemented case declares no environment it can run in.',
        });
    }
}

function checkQuarantine(
    capabilityCase: IWindowsCapabilityCase,
    now: Date,
    problems: IRegistryLintProblem[],
) {
    const record = capabilityCase.quarantine;
    if (record === null) {
        if (capabilityCase.status === 'quarantined') {
            problems.push({
                caseId: capabilityCase.id,
                message: 'Quarantined case has no quarantine record.',
            });
        }
        return;
    }
    if (record.owner.trim().length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Quarantine record is missing an owner.',
        });
    }
    if (record.reason.trim().length === 0) {
        problems.push({
            caseId: capabilityCase.id,
            message: 'Quarantine record is missing a reason.',
        });
    }
    const expiry = Date.parse(record.expiresAt);
    if (Number.isNaN(expiry)) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Quarantine record has an unparsable expiry "${record.expiresAt}".`,
        });
        return;
    }
    if (expiry <= now.getTime()) {
        problems.push({
            caseId: capabilityCase.id,
            message: `Quarantine expired at ${record.expiresAt}; renew it with evidence or restore the case.`,
        });
    }
}

export function lintCapabilityRegistry(
    registry: IWindowsCapabilityRegistry,
    options: IRegistryLintOptions,
): IRegistryLintResult {
    const problems: IRegistryLintProblem[] = [];
    const knownEnvironmentIds = new Set(registry.environments.map(environment => environment.id));
    const seen = new Set<string>();
    const now = options.now ?? new Date();

    if (registry.environments.length === 0) {
        problems.push({
            caseId: REGISTRY_SCOPE,
            message: 'Registry declares no environments.',
        });
    }
    if (registry.environments.filter(environment => environment.primary).length !== 1) {
        problems.push({
            caseId: REGISTRY_SCOPE,
            message: 'Exactly one environment must be marked primary.',
        });
    }
    if (registry.cases.length === 0) {
        problems.push({
            caseId: REGISTRY_SCOPE,
            message: 'Registry declares no cases.',
        });
    }

    for (const capabilityCase of registry.cases) {
        checkIdentity(capabilityCase, seen, problems);
        checkReferences(capabilityCase, knownEnvironmentIds, options, problems);
        checkStatusAndGate(capabilityCase, options, problems);
        checkQuarantine(capabilityCase, now, problems);
    }

    return {
        ok: problems.length === 0,
        problems,
    };
}

export function formatRegistryLintProblems(result: IRegistryLintResult) {
    return result.problems.map(problem => `${problem.caseId}: ${problem.message}`);
}
