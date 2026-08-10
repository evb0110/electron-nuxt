import {isRecord} from '@contracts/runtimeGuards';
import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IQuarantineTestMetadata {
    path: string;
    targetProject: 'e2e-blocking-smoke' | 'e2e-regression';
    consecutiveGreenScheduledRuns: number;
}

interface IQuarantineGraduationPolicy {
    $schema: string;
    version: number;
    lane: {
        events: string[];
        blocking: boolean;
        retryCount: number;
        minimumConsecutiveGreenScheduledRuns: number;
    };
    tests: IQuarantineTestMetadata[];
}

const quarantineDirectory = 'tests/e2e/electron/quarantine';
const graduationPolicyPath = `${quarantineDirectory}/graduation-policy.json`;
const graduationSchemaPath = `${quarantineDirectory}/graduation-policy.schema.json`;

function readJsonRecord(path: string) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(value)) {
        throw new Error(`${path} must contain a JSON object.`);
    }
    return value;
}

function parseTestMetadata(value: unknown, index: number): IQuarantineTestMetadata {
    if (
        !isRecord(value)
        || typeof value.path !== 'string'
        || (value.targetProject !== 'e2e-regression' && value.targetProject !== 'e2e-blocking-smoke')
        || !Number.isInteger(value.consecutiveGreenScheduledRuns)
    ) {
        throw new Error(`Invalid quarantine test metadata at index ${index}.`);
    }

    return {
        path: value.path,
        targetProject: value.targetProject,
        consecutiveGreenScheduledRuns: value.consecutiveGreenScheduledRuns as number,
    };
}

function parseGraduationPolicy(): IQuarantineGraduationPolicy {
    const value = readJsonRecord(graduationPolicyPath);
    if (
        value.$schema !== './graduation-policy.schema.json'
        || value.version !== 1
        || !isRecord(value.lane)
        || !Array.isArray(value.lane.events)
        || !value.lane.events.every(event => typeof event === 'string')
        || typeof value.lane.blocking !== 'boolean'
        || !Number.isInteger(value.lane.retryCount)
        || !Number.isInteger(value.lane.minimumConsecutiveGreenScheduledRuns)
        || !Array.isArray(value.tests)
    ) {
        throw new Error('Invalid quarantine graduation policy.');
    }

    return {
        $schema: value.$schema,
        version: value.version,
        lane: {
            events: value.lane.events,
            blocking: value.lane.blocking,
            retryCount: value.lane.retryCount as number,
            minimumConsecutiveGreenScheduledRuns: value.lane.minimumConsecutiveGreenScheduledRuns as number,
        },
        tests: value.tests.map(parseTestMetadata),
    };
}

function workflowJob(workflow: string, jobName: string) {
    const start = workflow.indexOf(`  ${jobName}:\n`);
    if (start === -1) {
        throw new Error(`Missing workflow job: ${jobName}`);
    }
    const nextJob = workflow.slice(start + 1).search(/\n {2}[a-z0-9_]+:\n/u);
    return nextJob === -1
        ? workflow.slice(start)
        : workflow.slice(start, start + 1 + nextJob);
}

describe('Electron E2E quarantine graduation policy', () => {
    it('keeps the manifest inventory complete and below the graduation threshold', () => {
        const policy = parseGraduationPolicy();
        const actualTestPaths = readdirSync(quarantineDirectory)
            .filter(name => name.endsWith('.e2e.test.ts'))
            .map(name => `${quarantineDirectory}/${name}`)
            .sort();
        const metadataPaths = policy.tests.map(test => test.path).sort();

        expect(policy.lane).toEqual({
            events: [
                'schedule',
                'workflow_dispatch',
            ],
            blocking: false,
            retryCount: 2,
            minimumConsecutiveGreenScheduledRuns: 30,
        });
        expect(new Set(metadataPaths).size).toBe(metadataPaths.length);
        expect(metadataPaths).toEqual(actualTestPaths);
        for (const test of policy.tests) {
            expect(test.consecutiveGreenScheduledRuns).toBeGreaterThanOrEqual(0);
            expect(test.consecutiveGreenScheduledRuns)
                .toBeLessThan(policy.lane.minimumConsecutiveGreenScheduledRuns);
        }
    });

    it('keeps the schema threshold aligned with the manifest policy', () => {
        const policy = parseGraduationPolicy();
        const schema = readJsonRecord(graduationSchemaPath);
        const properties = schema.properties;
        if (!isRecord(properties) || !isRecord(properties.tests)) {
            throw new Error('Quarantine graduation schema must define tests.');
        }
        const items = properties.tests.items;
        if (!isRecord(items) || !isRecord(items.properties)) {
            throw new Error('Quarantine graduation schema must define test metadata.');
        }
        const greenRuns = items.properties.consecutiveGreenScheduledRuns;
        if (!isRecord(greenRuns)) {
            throw new Error('Quarantine graduation schema must define the green-run counter.');
        }

        expect(greenRuns.minimum).toBe(0);
        expect(greenRuns.maximum)
            .toBe(policy.lane.minimumConsecutiveGreenScheduledRuns - 1);
    });

    it('keeps CI scheduling, retry, and policy validation wired to the manifest', () => {
        const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
        const quarantineJob = workflowJob(workflow, 'nightly_electron_e2e_quarantine');
        const vitestConfig = readFileSync('vitest.shared.config.ts', 'utf8');
        const packageJson = readFileSync('package.json', 'utf8');
        const readme = readFileSync(`${quarantineDirectory}/README.md`, 'utf8');

        expect(quarantineJob).toContain(
            'if: ${{ github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\' }}',
        );
        expect(quarantineJob).toContain('continue-on-error: true');
        expect(quarantineJob).toContain(
            'run: pnpm exec vitest run --project unit-static-architecture tests/unit/architecture/quarantineGraduationPolicy.test.ts',
        );
        expect(quarantineJob).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(vitestConfig).toMatch(/condition: \/\\\[INFRA\\\]\/u,[\s\S]*?count: 2,/u);
        expect(packageJson).toContain(
            'vitest run --project e2e-quarantine --passWithNoTests',
        );
        expect(readme).toContain('`graduation-policy.json`');
        expect(readme).toContain('after 30 green');
    });
});
