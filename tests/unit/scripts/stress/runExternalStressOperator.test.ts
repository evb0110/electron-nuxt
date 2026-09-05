import {
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runExternalStressOperator } from '@scripts/stress/runExternalStressOperator';
import type { IStressOperatorDriverOptions } from '@scripts/stress/runStressOperatorScenario';
import type { IStressOperatorToolContext } from '@scripts/stress/stressOperatorToolExecutor';
import { STRESS_SCENARIOS } from '@scripts/stress/stressScenarioRegistry';

const mocks = vi.hoisted(() => ({ getSessionInfo: vi.fn() }));
vi.mock('@scripts/electron-run/electronRunSessionArtifacts', () => ({ getSessionInfo: mocks.getSessionInfo }));
let directory = '';

function options(mode: 'completed' | 'blocked' | 'invalid' | 'stale' | 'timeout' | 'missing-evidence' | 'outside-evidence'): IStressOperatorDriverOptions {
    const scenario = STRESS_SCENARIOS.find(candidate => candidate.kind === 'operator');
    if (!scenario || scenario.kind !== 'operator') {
        throw new Error('operator scenario missing');
    }
    return {
        scenario,
        runId: 'test-run',
        model: 'external-agent',
        operatorProfile: 'external',
        budgets: {
            ...scenario.budgets,
            deadlineMs: mode === 'timeout' ? 10 : 5_000,
        },
        runCost: {
            totalUsd: () => 0,
            maxUsd: 40,
        },
        filePaths: ['/working/doc.pdf'],
        toolContext: { session: { name: 'external-test' } } as IStressOperatorToolContext,
        sampler: null,
        scenarioDir: directory,
        enableThinking: false,
        log: line => {
            if (!line.startsWith('EXTERNAL OPERATOR READY:') || mode === 'timeout') {
                return;
            }
            const request = JSON.parse(readFileSync(join(directory, 'operator-request.json'), 'utf8')) as {
                requestId: string;
                reportPath: string
            };
            writeFileSync(join(directory, 'screenshot.png'), 'test image evidence');
            writeFileSync(join(directory, 'operator-actions.jsonl'), '{"action":"open document"}\n');
            writeFileSync(request.reportPath, JSON.stringify({
                requestId: mode === 'stale' ? 'previous-session' : request.requestId,
                outcome: mode === 'blocked' ? 'blocked' : 'completed',
                stepsDone: mode === 'invalid' || mode === 'blocked' ? [] : ['opened document'],
                problem: mode === 'blocked' ? 'cannot click' : null,
                slowestAction: null,
                finalPage: 12,
                evidence: mode === 'blocked' || mode === 'missing-evidence' ? [] : [
                    mode === 'outside-evidence' ? '../outside.png' : 'screenshot.png',
                    'operator-actions.jsonl',
                ],
            }));
        },
    };
}

describe('external stress operator handoff', () => {
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'external-stress-'));
        mocks.getSessionInfo.mockReturnValue({
            electronPid: 1234,
            cdpPort: 4321,
        });
        vi.stubEnv('ANTHROPIC_API_KEY', '');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, {
            recursive: true,
            force: true,
        });
    });
    it.each([
        'completed',
        'blocked',
    ] as const)('accepts a matching %s report without any API client', async mode => {
        const result = await runExternalStressOperator(options(mode));
        expect(result.report?.outcome).toBe(mode);
        expect(result.costUsd).toBeNull();
        const task = await readFile(join(directory, 'task-card.txt'), 'utf8');
        expect(task).toContain('http://127.0.0.1:4321');
        expect(task).toContain('/working/doc.pdf');
        expect(task).toContain('--session=external-test');
        expect(task).toContain('Use the native Open dialog');
        expect(task).not.toContain('Do not use File > Open');
        expect(JSON.parse(await readFile(join(directory, 'operator-request.json'), 'utf8'))).toMatchObject({ status: 'closed' });
    });
    it.each([
        'invalid',
        'stale',
        'missing-evidence',
        'outside-evidence',
    ] as const)('rejects a %s report and closes the handoff', async mode => {
        await expect(runExternalStressOperator(options(mode))).rejects.toThrow(/External operator report/u);
        expect(JSON.parse(await readFile(join(directory, 'operator-request.json'), 'utf8'))).toMatchObject({ status: 'closed' });
    });
    it('ends at the deadline with no report rather than fabricating completion', async () => {
        const result = await runExternalStressOperator(options('timeout'));
        expect(result.report).toBeNull();
        expect(result.stopReason).toContain('deadline exceeded');
    });
    it('refuses to hand off an unidentified session', async () => {
        mocks.getSessionInfo.mockReturnValue(null);
        await expect(runExternalStressOperator(options('completed'))).rejects.toThrow('metadata is unavailable');
    });
});
