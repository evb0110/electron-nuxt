import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    loadCapabilityRegistry,
    resolveSuite,
} from '@scripts/windows-test/registry/capabilityRegistry';
import type { IWindowsCapabilityRegistry } from '@scripts/windows-test/registry/capabilityRegistry';

export const HUMAN_REVIEW_ORACLE_ID = 'human-review';

export interface IWindowsTestSuiteSelection {
    tests: string[];
    uncoveredObligations: string[];
    humanReviewObligations: string[];
}

export interface IWindowsTestSuiteResolver {resolveSuite(suite: TWindowsTestSuite, environment: string): Promise<IWindowsTestSuiteSelection>;}

export interface IFixtureManifestSource {sha256(): Promise<string>;}

// A case that lists the human-review oracle produces evidence only a person can
// judge, so the run carries that obligation next to, never inside, the
// automated outcome (invariant I8). Only cases that will execute can produce
// such evidence; planned or out-of-environment cases stay uncovered instead.
export function selectWindowsTestSuite(
    registry: IWindowsCapabilityRegistry,
    suite: TWindowsTestSuite,
    environment: string,
): IWindowsTestSuiteSelection {
    const resolution = resolveSuite(registry, suite, environment);
    const executing = new Set(resolution.tests);
    const humanReviewObligations = registry.cases
        .filter(entry => executing.has(entry.id) && entry.oracles.includes(HUMAN_REVIEW_ORACLE_ID))
        .map(entry => entry.id);
    return {
        tests: [...resolution.tests],
        uncoveredObligations: [...resolution.uncoveredObligations],
        humanReviewObligations,
    };
}

export function createCapabilityFileSuiteResolver(registryPath: string): IWindowsTestSuiteResolver {
    return {resolveSuite: async (suite, environment) => {
        let registry: IWindowsCapabilityRegistry;
        try {
            registry = await loadCapabilityRegistry(registryPath);
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                throw new Error(`Windows capability registry ${registryPath} is missing; run the host from a full repository checkout.`);
            }
            throw error;
        }
        return selectWindowsTestSuite(registry, suite, environment);
    }};
}

export function createFileFixtureManifestSource(manifestPath: string): IFixtureManifestSource {
    return {sha256: async () => {
        const bytes = await readFile(manifestPath).catch(() => {
            throw new Error(`Windows test fixture manifest ${manifestPath} is missing; stage the fixture cache before running the suite.`);
        });
        return createHash('sha256').update(bytes).digest('hex');
    }};
}
