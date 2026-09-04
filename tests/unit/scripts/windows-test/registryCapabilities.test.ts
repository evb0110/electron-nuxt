import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IWindowsCapabilityCase,
    IWindowsCapabilityRegistry,
} from '@scripts/windows-test/registry/capabilityRegistry';
import {
    assertRegistryTestIds,
    collectRegistryFixtureIds,
    collectRegistryOracleIds,
    coverageReport,
    describeUncoveredObligation,
    findCapabilityCase,
    isWindowsCapabilityRegistry,
    loadCapabilityRegistry,
    resolveSuite,
} from '@scripts/windows-test/registry/capabilityRegistry';

const PRIMARY_ENVIRONMENT = 'utm-win11-arm64-app-arm64';
const SECONDARY_ENVIRONMENT = 'hosted-win-x64-native';
const HARDWARE_ENVIRONMENT = 'physical-win-x64';

const temporaryDirectories: string[] = [];

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

async function createTemporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-registry-'));
    temporaryDirectories.push(directory);
    return directory;
}

function buildCase(overrides: Partial<IWindowsCapabilityCase> = {}): IWindowsCapabilityCase {
    return {
        id: 'WIN-SAVE-01',
        family: 'Saving, editing, identity and recovery',
        title: 'Delete a page, save, delete another page and save again',
        driver: 'APP',
        priority: 'P0',
        obligation: 'automated',
        status: 'implemented',
        gate: 'advisory',
        suites: [
            'smoke',
            'critical',
        ],
        primaryEnvironment: PRIMARY_ENVIRONMENT,
        environments: [PRIMARY_ENVIRONMENT],
        fixtures: ['F01'],
        oracles: [
            'page-count',
            'page-markers',
        ],
        negativeControl: 'Wrong page marker control must fail this case.',
        owner: 'desktop-test-engineer',
        quarantine: null,
        ...overrides,
    };
}

function buildRegistry(cases: IWindowsCapabilityCase[]): IWindowsCapabilityRegistry {
    return {
        schemaVersion: 1,
        environments: [
            {
                id: PRIMARY_ENVIRONMENT,
                osArch: 'arm64',
                appArch: 'arm64',
                kind: 'utm',
                primary: true,
            },
            {
                id: SECONDARY_ENVIRONMENT,
                osArch: 'x64',
                appArch: 'x64',
                kind: 'hosted-ci',
                primary: false,
            },
            {
                id: HARDWARE_ENVIRONMENT,
                osArch: 'x64',
                appArch: 'x64',
                kind: 'hardware',
                primary: false,
            },
        ],
        cases,
    };
}

describe('loadCapabilityRegistry', () => {
    it('loads a registry that matches the schema', async () => {
        const directory = await createTemporaryDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        await writeFile(registryPath, JSON.stringify(buildRegistry([buildCase()])));
        const registry = await loadCapabilityRegistry(registryPath);
        expect(registry.cases).toHaveLength(1);
        expect(registry.environments.map(entry => entry.id)).toContain(PRIMARY_ENVIRONMENT);
    });

    it('reports invalid JSON with the file path', async () => {
        const directory = await createTemporaryDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        await writeFile(registryPath, '{ not json');
        await expect(loadCapabilityRegistry(registryPath)).rejects.toThrow(/is not valid JSON/u);
    });

    it('rejects a payload that fails the type guard', async () => {
        const directory = await createTemporaryDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        await writeFile(registryPath, JSON.stringify({
            schemaVersion: 1,
            environments: [],
            cases: [{ id: 'WIN-SAVE-01' }],
        }));
        await expect(loadCapabilityRegistry(registryPath)).rejects.toThrow(/does not match the expected schema/u);
    });

    it('rejects an unknown status through the guard', () => {
        expect(isWindowsCapabilityRegistry(buildRegistry([buildCase()]))).toBe(true);
        expect(isWindowsCapabilityRegistry({
            ...buildRegistry([buildCase()]),
            cases: [{
                ...buildCase(),
                status: 'skipped',
            }],
        })).toBe(false);
    });
});

describe('resolveSuite', () => {
    const registry = buildRegistry([
        buildCase(),
        buildCase({
            id: 'WIN-PRINT-01',
            family: 'Printing',
            status: 'planned',
            suites: ['critical'],
        }),
        buildCase({
            id: 'WIN-PATH-05',
            family: 'Filesystem and paths',
            obligation: 'manual',
            status: 'planned',
            suites: ['all'],
            fixtures: [],
        }),
        buildCase({
            id: 'WIN-PRINT-10',
            family: 'Printing',
            obligation: 'hardware',
            status: 'planned',
            suites: ['all'],
            primaryEnvironment: HARDWARE_ENVIRONMENT,
            environments: [HARDWARE_ENVIRONMENT],
            fixtures: [],
        }),
    ]);

    it('selects only implemented automated cases that name the environment', () => {
        const resolution = resolveSuite(registry, 'critical', PRIMARY_ENVIRONMENT);
        expect(resolution.tests).toEqual(['WIN-SAVE-01']);
    });

    it('formats every uncovered obligation as "WIN-X-NN: reason"', () => {
        const resolution = resolveSuite(registry, 'all', PRIMARY_ENVIRONMENT);
        expect(resolution.tests).toEqual(['WIN-SAVE-01']);
        for (const entry of resolution.uncoveredObligations) {
            expect(entry).toMatch(/^WIN-[A-Z]+-\d{2}: .+$/u);
        }
        expect(resolution.uncoveredObligations).toContain(
            'WIN-PATH-05: manual obligation owned by desktop-test-engineer, primary environment utm-win11-arm64-app-arm64',
        );
        expect(resolution.uncoveredObligations).toContain(
            'WIN-PRINT-10: hardware obligation owned by desktop-test-engineer, primary environment physical-win-x64',
        );
        expect(resolution.uncoveredObligations).toContain(
            'WIN-PRINT-01: planned, not implemented, owned by desktop-test-engineer',
        );
    });

    it('reports an implemented case that does not run in the requested environment', () => {
        const resolution = resolveSuite(registry, 'smoke', SECONDARY_ENVIRONMENT);
        expect(resolution.tests).toEqual([]);
        expect(resolution.uncoveredObligations).toContain(
            `WIN-SAVE-01: not applicable to ${SECONDARY_ENVIRONMENT}, primary environment ${PRIMARY_ENVIRONMENT}`,
        );
    });
});

describe('describeUncoveredObligation', () => {
    it('leads with the quarantine record when one exists', () => {
        const description = describeUncoveredObligation(
            buildCase({
                status: 'quarantined',
                quarantine: {
                    owner: 'desktop-test-engineer',
                    reason: 'Print spooler flake under investigation',
                    expiresAt: '2026-10-01T00:00:00.000Z',
                    replacementCoverage: 'WIN-PRINT-02 covers the same path',
                },
            }),
            PRIMARY_ENVIRONMENT,
        );
        expect(description).toBe(
            'quarantined until 2026-10-01T00:00:00.000Z: Print spooler flake under investigation',
        );
    });

    it('explains a not-applicable and an unsupported case', () => {
        expect(describeUncoveredObligation(
            buildCase({
                status: 'not-applicable',
                note: 'ARM64 host cannot run this',
            }),
            PRIMARY_ENVIRONMENT,
        )).toBe('not applicable: ARM64 host cannot run this');
        expect(describeUncoveredObligation(
            buildCase({
                status: 'unsupported-in-environment',
                note: 'needs a physical printer',
            }),
            PRIMARY_ENVIRONMENT,
        )).toBe(`unsupported in ${PRIMARY_ENVIRONMENT}: needs a physical printer`);
    });
});

describe('coverageReport', () => {
    const registry = buildRegistry([
        buildCase(),
        buildCase({
            id: 'WIN-SAVE-02',
            status: 'implemented',
        }),
        buildCase({
            id: 'WIN-PRINT-01',
            family: 'Printing',
            status: 'planned',
        }),
        buildCase({
            id: 'WIN-PRINT-10',
            family: 'Printing',
            obligation: 'hardware',
            status: 'planned',
            primaryEnvironment: HARDWARE_ENVIRONMENT,
            environments: [HARDWARE_ENVIRONMENT],
            fixtures: [],
        }),
        buildCase({
            id: 'WIN-UI-09',
            family: 'Input, display and accessibility',
            obligation: 'manual',
            status: 'planned',
            fixtures: [],
        }),
    ]);

    it('never counts planned, manual or hardware obligations as applicable or passed', () => {
        const report = coverageReport(registry, PRIMARY_ENVIRONMENT, [
            {
                testId: 'WIN-SAVE-01',
                outcome: 'passed',
            },
            {
                testId: 'WIN-PRINT-01',
                outcome: 'passed',
            },
            {
                testId: 'WIN-UI-09',
                outcome: 'passed',
            },
            {
                testId: 'WIN-PRINT-10',
                outcome: 'passed',
            },
        ]);
        expect(report.overall.total).toBe(5);
        expect(report.overall.applicable).toBe(2);
        expect(report.overall.executedPassed).toBe(1);
        expect(report.overall.notExecuted).toBe(1);
        expect(report.overall.plannedOrDeferred).toBe(3);
    });

    it('publishes an explicit denominator per family and per environment', () => {
        const report = coverageReport(registry, PRIMARY_ENVIRONMENT, [
            {
                testId: 'WIN-SAVE-01',
                outcome: 'passed',
            },
            {
                testId: 'WIN-SAVE-02',
                outcome: 'product-failed',
            },
        ]);
        const savingFamily = report.byFamily['Saving, editing, identity and recovery'];
        expect(savingFamily).toBeDefined();
        expect(savingFamily?.applicable).toBe(2);
        expect(savingFamily?.executedPassed).toBe(1);
        expect(savingFamily?.executedFailed).toBe(1);
        const printingFamily = report.byFamily.Printing;
        expect(printingFamily?.total).toBe(2);
        expect(printingFamily?.applicable).toBe(0);
        expect(Object.keys(report.byEnvironment).sort()).toEqual([
            HARDWARE_ENVIRONMENT,
            SECONDARY_ENVIRONMENT,
            PRIMARY_ENVIRONMENT,
        ].sort());
        expect(report.byEnvironment[SECONDARY_ENVIRONMENT]?.applicable).toBe(0);
        expect(report.byEnvironment[SECONDARY_ENVIRONMENT]?.total).toBe(5);
        expect(report.uncoveredObligations).toHaveLength(3);
    });
});

describe('registry helpers', () => {
    const registry = buildRegistry([
        buildCase(),
        buildCase({
            id: 'WIN-PRINT-01',
            fixtures: [
                'F01',
                'F03',
            ],
            oracles: ['render-nonblank'],
        }),
    ]);

    it('collects sorted unique fixture and oracle IDs', () => {
        expect(collectRegistryFixtureIds(registry)).toEqual([
            'F01',
            'F03',
        ]);
        expect(collectRegistryOracleIds(registry)).toEqual([
            'page-count',
            'page-markers',
            'render-nonblank',
        ]);
    });

    it('finds a case by ID and reports malformed IDs', () => {
        expect(findCapabilityCase(registry, 'WIN-PRINT-01')?.id).toBe('WIN-PRINT-01');
        expect(findCapabilityCase(registry, 'WIN-NOPE-99')).toBeNull();
        expect(assertRegistryTestIds(registry)).toEqual([]);
        expect(assertRegistryTestIds(buildRegistry([buildCase({ id: 'win-save-1' })]))).toEqual(['win-save-1']);
    });
});
