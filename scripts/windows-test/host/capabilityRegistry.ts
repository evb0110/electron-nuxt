import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    isOneOf,
    isErrnoException,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_SCHEMA_VERSION,
    isWindowsTestId,
    windowsTestCaseStatuses,
    windowsTestDrivers,
    windowsTestGatePolicies,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    TWindowsTestCaseStatus,
    TWindowsTestDriver,
    TWindowsTestGatePolicy,
    TWindowsTestSuite,
} from '@scripts/windows-test/contracts/windowsTestContracts';

export interface IWindowsTestCapabilityCase {
    id: string;
    family: string;
    driver: TWindowsTestDriver;
    status: TWindowsTestCaseStatus;
    gate: TWindowsTestGatePolicy;
    suites: string[];
    environments: string[];
    fixtures: string[];
    oracles: string[];
    owner: string;
    humanReview: boolean;
}

export interface IWindowsTestCapabilityRegistry {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    environments: string[];
    cases: IWindowsTestCapabilityCase[];
}

export interface IWindowsTestSuiteSelection {
    tests: string[];
    uncoveredObligations: string[];
    humanReviewObligations: string[];
}

export interface IWindowsTestSuiteResolver {resolveSuite(suite: TWindowsTestSuite, environment: string): Promise<IWindowsTestSuiteSelection>;}

export interface IFixtureManifestSource {sha256(): Promise<string>;}

function isCapabilityCase(value: unknown): value is IWindowsTestCapabilityCase {
    return isRecord(value)
        && isWindowsTestId(value.id)
        && typeof value.family === 'string'
        && isOneOf(windowsTestDrivers, value.driver)
        && isOneOf(windowsTestCaseStatuses, value.status)
        && isOneOf(windowsTestGatePolicies, value.gate)
        && isStringArray(value.suites)
        && isStringArray(value.environments)
        && isStringArray(value.fixtures)
        && isStringArray(value.oracles)
        && typeof value.owner === 'string'
        && (value.humanReview === undefined || typeof value.humanReview === 'boolean');
}

export function parseWindowsTestCapabilityRegistry(
    value: unknown,
    sourcePath: string,
): IWindowsTestCapabilityRegistry {
    if (!isRecord(value) || value.schemaVersion !== WINDOWS_TEST_SCHEMA_VERSION) {
        throw new Error(`Windows test capability registry ${sourcePath} must declare schemaVersion ${WINDOWS_TEST_SCHEMA_VERSION}.`);
    }
    if (!isStringArray(value.environments)) {
        throw new Error(`Windows test capability registry ${sourcePath} field "environments" must be an array of strings.`);
    }
    if (!Array.isArray(value.cases) || !value.cases.every(isCapabilityCase)) {
        throw new Error(`Windows test capability registry ${sourcePath} field "cases" must be an array of capability cases.`);
    }
    const cases = value.cases.map(entry => ({
        ...entry,
        humanReview: entry.humanReview ?? false,
    }));
    const duplicateIds = cases
        .map(entry => entry.id)
        .filter((id, index, all) => all.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
        throw new Error(`Windows test capability registry ${sourcePath} repeats case IDs: ${[...new Set(duplicateIds)].join(', ')}.`);
    }
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        environments: value.environments,
        cases,
    };
}

function sortedUnique(values: readonly string[]) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

// `all` selects every implemented case applicable to the environment and keeps
// planned, quarantined, out-of-environment and manual obligations visible as
// uncovered. They can never be reported as passed (invariant I8).
export function selectWindowsTestSuite(
    registry: IWindowsTestCapabilityRegistry,
    suite: TWindowsTestSuite,
    environment: string,
): IWindowsTestSuiteSelection {
    const tests: string[] = [];
    const uncovered: string[] = [];
    const humanReview: string[] = [];

    for (const capabilityCase of registry.cases) {
        const inSuite = suite === 'all' || capabilityCase.suites.includes(suite);
        if (!inSuite) {
            continue;
        }
        if (capabilityCase.humanReview) {
            humanReview.push(capabilityCase.id);
        }
        const inEnvironment = capabilityCase.environments.includes(environment);
        if (!inEnvironment) {
            uncovered.push(capabilityCase.id);
            continue;
        }
        if (capabilityCase.status === 'implemented') {
            tests.push(capabilityCase.id);
            continue;
        }
        uncovered.push(capabilityCase.id);
    }

    return {
        tests: sortedUnique(tests),
        uncoveredObligations: sortedUnique(uncovered),
        humanReviewObligations: sortedUnique(humanReview),
    };
}

export function createStaticSuiteResolver(registry: IWindowsTestCapabilityRegistry): IWindowsTestSuiteResolver {
    return {resolveSuite: (suite, environment) => Promise.resolve(
        selectWindowsTestSuite(registry, suite, environment),
    )};
}

function emptySelection(): IWindowsTestSuiteSelection {
    return {
        tests: [],
        uncoveredObligations: [],
        humanReviewObligations: [],
    };
}

// The registry file belongs to the test-registry package and may not exist yet;
// an absent file yields an empty selection so the caller reports "no registered
// cases" instead of crashing.
export function createCapabilityFileSuiteResolver(registryPath: string): IWindowsTestSuiteResolver {
    return {resolveSuite: async (suite, environment) => {
        let raw: string;
        try {
            raw = await readFile(registryPath, 'utf8');
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return emptySelection();
            }
            throw error;
        }
        const registry = parseWindowsTestCapabilityRegistry(JSON.parse(raw), registryPath);
        return selectWindowsTestSuite(registry, suite, environment);
    }};
}

export function createStaticFixtureManifestSource(sha256: string): IFixtureManifestSource {
    return {sha256: () => Promise.resolve(sha256)};
}

export function createFileFixtureManifestSource(manifestPath: string): IFixtureManifestSource {
    return {sha256: async () => {
        const bytes = await readFile(manifestPath).catch(() => {
            throw new Error(`Windows test fixture manifest ${manifestPath} is missing; stage the fixture cache before running the suite.`);
        });
        return createHash('sha256').update(bytes).digest('hex');
    }};
}
