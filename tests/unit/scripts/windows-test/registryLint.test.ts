import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IWindowsCapabilityCase,
    IWindowsCapabilityRegistry,
} from '@scripts/windows-test/registry/capabilityRegistry';
import type { IRegistryLintOptions } from '@scripts/windows-test/registry/registryLint';
import {
    formatRegistryLintProblems,
    lintCapabilityRegistry,
} from '@scripts/windows-test/registry/registryLint';

const PRIMARY_ENVIRONMENT = 'utm-win11-arm64-app-arm64';
const SECONDARY_ENVIRONMENT = 'hosted-win-x64-native';
const NOW = new Date('2026-09-04T00:00:00.000Z');

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
        suites: ['critical'],
        primaryEnvironment: PRIMARY_ENVIRONMENT,
        environments: [PRIMARY_ENVIRONMENT],
        fixtures: ['F01'],
        oracles: ['page-count'],
        negativeControl: 'The wrong page marker control must fail this case.',
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
        ],
        cases,
    };
}

function options(overrides: Partial<IRegistryLintOptions> = {}): IRegistryLintOptions {
    return {
        knownFixtureIds: [
            'F01',
            'F02',
        ],
        knownOracleIds: [
            'page-count',
            'page-markers',
        ],
        implementedCaseIds: ['WIN-SAVE-01'],
        now: NOW,
        ...overrides,
    };
}

function messagesFor(registry: IWindowsCapabilityRegistry, lintOptions = options()) {
    return formatRegistryLintProblems(lintCapabilityRegistry(registry, lintOptions));
}

describe('lintCapabilityRegistry', () => {
    it('accepts a well-formed registry', () => {
        const result = lintCapabilityRegistry(buildRegistry([buildCase()]), options());
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('rejects a malformed test ID', () => {
        expect(messagesFor(buildRegistry([buildCase({ id: 'WIN-save-1' })]))).toEqual(
            expect.arrayContaining([expect.stringContaining('does not match WIN-')]),
        );
    });

    it('rejects duplicate test IDs', () => {
        const messages = messagesFor(buildRegistry([
            buildCase(),
            buildCase(),
        ]));
        expect(messages).toEqual(expect.arrayContaining(['WIN-SAVE-01: Duplicate test ID "WIN-SAVE-01".']));
    });

    it('rejects an empty owner and an empty negative control', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            owner: '  ',
            negativeControl: '',
        })]));
        expect(messages).toEqual(expect.arrayContaining([
            'WIN-SAVE-01: Owner role is empty.',
            'WIN-SAVE-01: Negative control description is empty.',
        ]));
    });

    it('rejects an empty oracle list', () => {
        expect(messagesFor(buildRegistry([buildCase({ oracles: [] })]))).toEqual(
            expect.arrayContaining(['WIN-SAVE-01: Oracle list is empty.']),
        );
    });

    it('rejects an empty fixture list only for automated cases', () => {
        expect(messagesFor(buildRegistry([buildCase({ fixtures: [] })]))).toEqual(
            expect.arrayContaining(['WIN-SAVE-01: Automated case has an empty fixture list.']),
        );
        const manual = messagesFor(buildRegistry([buildCase({
            id: 'WIN-UI-09',
            obligation: 'manual',
            status: 'planned',
            fixtures: [],
        })]));
        expect(manual).toEqual([]);
    });

    it('rejects unknown fixture and oracle IDs', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            fixtures: ['F42'],
            oracles: ['telepathy'],
        })]));
        expect(messages).toEqual(expect.arrayContaining([
            'WIN-SAVE-01: Unknown fixture ID "F42".',
            'WIN-SAVE-01: Unknown oracle ID "telepathy".',
        ]));
    });

    it('rejects unknown environment references', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            primaryEnvironment: 'utm-win12-arm64',
            environments: ['utm-win12-arm64'],
        })]));
        expect(messages).toEqual(expect.arrayContaining([
            'WIN-SAVE-01: Unknown environment reference "utm-win12-arm64".',
            'WIN-SAVE-01: Unknown primary environment "utm-win12-arm64".',
        ]));
    });

    it('rejects a primary environment missing from the environment list', () => {
        const messages = messagesFor(buildRegistry([buildCase({environments: [SECONDARY_ENVIRONMENT]})]));
        expect(messages).toEqual(expect.arrayContaining([`WIN-SAVE-01: Primary environment "${PRIMARY_ENVIRONMENT}" is missing from the environment list.`]));
    });

    it('rejects a required gate on a case that does not run', () => {
        for (const status of [
            'planned',
            'quarantined',
            'not-applicable',
            'unsupported-in-environment',
        ] as const) {
            const messages = messagesFor(buildRegistry([buildCase({
                gate: 'required',
                status,
            })]));
            expect(messages).toEqual(expect.arrayContaining([`WIN-SAVE-01: Required case is ${status}; a required gate must reference a case that actually runs.`]));
        }
    });

    it('rejects a required gate on a manual or hardware obligation', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            gate: 'required',
            obligation: 'hardware',
        })]));
        expect(messages).toEqual(expect.arrayContaining(['WIN-SAVE-01: Required case carries a hardware obligation, which no automated run can close.']));
    });

    it('rejects an implemented case with no registered implementation', () => {
        const messages = messagesFor(
            buildRegistry([buildCase({ id: 'WIN-SAVE-02' })]),
            options({ implementedCaseIds: ['WIN-SAVE-01'] }),
        );
        expect(messages).toEqual(expect.arrayContaining(['WIN-SAVE-02: Case is marked implemented but no guest case implementation is registered for it.']));
    });

    it('rejects an implemented case with no environment', () => {
        const messages = messagesFor(buildRegistry([buildCase({ environments: [] })]));
        expect(messages).toEqual(expect.arrayContaining(['WIN-SAVE-01: Implemented case declares no environment it can run in.']));
    });

    it('rejects a quarantine record that is missing an owner, reason or expiry', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            status: 'quarantined',
            gate: 'advisory',
            quarantine: {
                owner: '',
                reason: '   ',
                expiresAt: 'soon',
                replacementCoverage: '',
            },
        })]));
        expect(messages).toEqual(expect.arrayContaining([
            'WIN-SAVE-01: Quarantine record is missing an owner.',
            'WIN-SAVE-01: Quarantine record is missing a reason.',
            'WIN-SAVE-01: Quarantine record has an unparsable expiry "soon".',
        ]));
    });

    it('rejects a quarantined case with no quarantine record', () => {
        const messages = messagesFor(buildRegistry([buildCase({
            status: 'quarantined',
            quarantine: null,
        })]));
        expect(messages).toEqual(expect.arrayContaining(['WIN-SAVE-01: Quarantined case has no quarantine record.']));
    });

    it('rejects an expired quarantine and accepts a live one', () => {
        const expired = messagesFor(buildRegistry([buildCase({
            status: 'quarantined',
            quarantine: {
                owner: 'desktop-test-engineer',
                reason: 'Spooler flake',
                expiresAt: '2026-08-01T00:00:00.000Z',
                replacementCoverage: 'WIN-PRINT-02',
            },
        })]));
        expect(expired).toEqual(expect.arrayContaining(['WIN-SAVE-01: Quarantine expired at 2026-08-01T00:00:00.000Z; renew it with evidence or restore the case.']));
        const live = messagesFor(buildRegistry([buildCase({
            status: 'quarantined',
            quarantine: {
                owner: 'desktop-test-engineer',
                reason: 'Spooler flake',
                expiresAt: '2026-10-01T00:00:00.000Z',
                replacementCoverage: 'WIN-PRINT-02',
            },
        })]));
        expect(live).toEqual([]);
    });

    it('rejects a registry with no cases, no environments or two primaries', () => {
        expect(messagesFor({
            schemaVersion: 1,
            environments: [],
            cases: [],
        })).toEqual(expect.arrayContaining([
            '<registry>: Registry declares no environments.',
            '<registry>: Exactly one environment must be marked primary.',
            '<registry>: Registry declares no cases.',
        ]));
        const twoPrimaries = buildRegistry([buildCase()]);
        const second = twoPrimaries.environments[1];
        expect(second).toBeDefined();
        if (second !== undefined) {
            second.primary = true;
        }
        expect(messagesFor(twoPrimaries)).toEqual(expect.arrayContaining(['<registry>: Exactly one environment must be marked primary.']));
    });

    it('defaults the clock to now when no date is injected', () => {
        const result = lintCapabilityRegistry(buildRegistry([buildCase()]), {
            knownFixtureIds: ['F01'],
            knownOracleIds: ['page-count'],
            implementedCaseIds: ['WIN-SAVE-01'],
        });
        expect(result.ok).toBe(true);
    });
});
