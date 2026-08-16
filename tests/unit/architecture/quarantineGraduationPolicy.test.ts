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
}

interface IQuarantineOperatorDiagnostic {
    path: string;
    reason: string;
}

interface IQuarantineGraduationPolicy {
    $schema: string;
    version: number;
    lane: {
        events: string[];
        blocking: boolean;
        infraRetryCount: number;
        reviewAfterScheduledRuns: number;
        graduationEvidence: string;
    };
    operatorDiagnostics: IQuarantineOperatorDiagnostic[];
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
    ) {
        throw new Error(`Invalid quarantine test metadata at index ${index}.`);
    }

    return {
        path: value.path,
        targetProject: value.targetProject,
    };
}

function parseOperatorDiagnostic(value: unknown, index: number): IQuarantineOperatorDiagnostic {
    if (
        !isRecord(value)
        || typeof value.path !== 'string'
        || typeof value.reason !== 'string'
        || value.reason.trim() === ''
    ) {
        throw new Error(`Invalid quarantine operator diagnostic at index ${index}.`);
    }

    return {
        path: value.path,
        reason: value.reason,
    };
}

function parseGraduationPolicy(): IQuarantineGraduationPolicy {
    const value = readJsonRecord(graduationPolicyPath);
    if (
        value.$schema !== './graduation-policy.schema.json'
        || value.version !== 2
        || !isRecord(value.lane)
        || !Array.isArray(value.lane.events)
        || !value.lane.events.every(event => typeof event === 'string')
        || typeof value.lane.blocking !== 'boolean'
        || !Number.isInteger(value.lane.infraRetryCount)
        || !Number.isInteger(value.lane.reviewAfterScheduledRuns)
        || typeof value.lane.graduationEvidence !== 'string'
        || !Array.isArray(value.operatorDiagnostics)
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
            infraRetryCount: value.lane.infraRetryCount as number,
            reviewAfterScheduledRuns: value.lane.reviewAfterScheduledRuns as number,
            graduationEvidence: value.lane.graduationEvidence,
        },
        operatorDiagnostics: value.operatorDiagnostics.map(parseOperatorDiagnostic),
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
    it('keeps the manifest inventory complete and separates diagnostics', () => {
        const policy = parseGraduationPolicy();
        const actualTestPaths = readdirSync(quarantineDirectory)
            .filter(name => name.endsWith('.e2e.test.ts'))
            .map(name => `${quarantineDirectory}/${name}`)
            .sort();
        const metadataPaths = policy.tests.map(test => test.path).sort();
        const diagnosticPaths = policy.operatorDiagnostics.map(diagnostic => diagnostic.path).sort();
        const declaredPaths = [
            ...metadataPaths,
            ...diagnosticPaths,
        ].sort();

        expect(policy.lane).toEqual({
            events: [
                'schedule',
                'workflow_dispatch',
            ],
            blocking: false,
            infraRetryCount: 2,
            reviewAfterScheduledRuns: 30,
            graduationEvidence: 'github-actions-scheduled-history-and-manual-review',
        });
        expect(new Set(metadataPaths).size).toBe(metadataPaths.length);
        expect(new Set(diagnosticPaths).size).toBe(diagnosticPaths.length);
        expect(new Set(declaredPaths).size).toBe(declaredPaths.length);
        expect(declaredPaths).toEqual(actualTestPaths);
        expect(diagnosticPaths).toEqual([
            'tests/e2e/electron/quarantine/scanCleanupAppTruthProbe.e2e.test.ts',
            'tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts',
        ]);
        expect(policy.operatorDiagnostics.every(diagnostic => diagnostic.reason.includes('excluded from graduation evidence')))
            .toBe(true);
    });

    it('keeps the schema aligned with review evidence and diagnostic inventory', () => {
        const policy = parseGraduationPolicy();
        const schema = readJsonRecord(graduationSchemaPath);
        const properties = schema.properties;
        if (!isRecord(properties) || !isRecord(properties.lane) || !isRecord(properties.tests)) {
            throw new Error('Quarantine graduation schema must define lane and tests.');
        }
        const laneProperties = properties.lane.properties;
        if (!isRecord(laneProperties)) {
            throw new Error('Quarantine graduation schema must define lane properties.');
        }
        expect(laneProperties.infraRetryCount).toEqual({const: policy.lane.infraRetryCount});
        expect(laneProperties.reviewAfterScheduledRuns).toEqual({const: policy.lane.reviewAfterScheduledRuns});
        expect(laneProperties.graduationEvidence).toEqual({const: policy.lane.graduationEvidence});
        const items = properties.tests.items;
        if (!isRecord(items) || !isRecord(items.properties)) {
            throw new Error('Quarantine graduation schema must define test metadata.');
        }
        expect(items.required).toEqual([
            'path',
            'targetProject',
        ]);
        expect(items.properties).not.toHaveProperty('consecutiveGreenScheduledRuns');
        expect(properties).toHaveProperty('operatorDiagnostics');
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
        expect(readme).toContain('`[INFRA]`');
        expect(readme).toContain('GitHub Actions scheduled-run history');
        expect(readme).toContain('30 green');
    });
});
