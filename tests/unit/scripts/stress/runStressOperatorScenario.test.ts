import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type {
    Message,
    MessageCreateParams,
    ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runStressOperatorScenario } from '@scripts/stress/runStressOperatorScenario';
import type { IStressOperatorDriverOptions } from '@scripts/stress/runStressOperatorScenario';
import type * as TStressAppState from '@scripts/stress/stressAppState';
import { DEFAULT_STRESS_OPERATOR_MODEL } from '@scripts/stress/stressOperatorCost';
import type {
    IStressOperatorToolContext,
    IStressToolExecution,
} from '@scripts/stress/stressOperatorToolExecutor';
import { STRESS_SCENARIOS } from '@scripts/stress/stressScenarioRegistry';
import type { IStressOperatorScenario } from '@scripts/stress/stressTypes';

const mocks = vi.hoisted(() => ({
    executeStressOperatorTool: vi.fn<() => Promise<IStressToolExecution>>(),
    collectStressAppState: vi.fn(async () => null),
}));

vi.mock('@scripts/stress/stressOperatorToolExecutor', () => ({executeStressOperatorTool: mocks.executeStressOperatorTool}));
vi.mock('@scripts/stress/stressAppState', async importOriginal => ({
    ...await importOriginal<typeof TStressAppState>(),
    collectStressAppState: mocks.collectStressAppState,
}));

function requireOperatorScenario(): IStressOperatorScenario {
    const found = STRESS_SCENARIOS.find((candidate): candidate is IStressOperatorScenario => candidate.kind === 'operator');
    if (!found) {
        throw new Error('registry has no operator scenario');
    }
    return found;
}

const scenario = requireOperatorScenario();

function message(content: Message['content'], stopReason: Message['stop_reason'] = 'tool_use'): Message {
    return Object.assign(Object.create(null) as Message, {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: DEFAULT_STRESS_OPERATOR_MODEL,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: 1_000,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: null,
            service_tier: null,
        },
    });
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
    return {
        type: 'tool_use',
        id,
        name,
        input,
        caller: {type: 'direct'},
    };
}

function createClient(responses: Array<Message | Error>) {
    const create = vi.fn<(params: MessageCreateParams) => Promise<Message>>(async () => {
        const next = responses.shift();
        if (next === undefined) {
            throw new Error('test ran out of canned responses');
        }
        if (next instanceof Error) {
            throw next;
        }
        return next;
    });
    return {
        client: Object.assign(Object.create(null) as Anthropic, {messages: {create}}),
        create,
    };
}

let scenarioDir = '';

function buildOptions(client: Anthropic, overrides: Partial<IStressOperatorDriverOptions> = {}): IStressOperatorDriverOptions {
    const toolContext = Object.assign(Object.create(null) as IStressOperatorToolContext, {
        session: {page: {}},
        allowedPaths: new Map(),
        viewport: {
            width: 1280,
            height: 800,
        },
        stepTimeoutMs: 1_000,
        log: () => undefined,
    });
    return {
        scenario,
        runId: 'run-test',
        model: DEFAULT_STRESS_OPERATOR_MODEL,
        operatorProfile: 'pixel',
        budgets: scenario.budgets,
        runCost: {
            totalUsd: () => 0,
            maxUsd: 40,
        },
        filePaths: ['/fixtures/doc.pdf'],
        toolContext,
        sampler: null,
        scenarioDir,
        enableThinking: false,
        log: () => undefined,
        client,
        ...overrides,
    };
}

async function readJsonLines(path: string) {
    const raw = await readFile(path, 'utf8');
    return raw.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('runStressOperatorScenario', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        scenarioDir = await mkdtemp(join(tmpdir(), 'stress-operator-'));
    });

    afterEach(async () => {
        await rm(scenarioDir, {
            recursive: true,
            force: true,
        });
    });

    it('executes tool calls, records evidence, and stops at the report', async () => {
        mocks.executeStressOperatorTool
            .mockResolvedValueOnce({
                content: 'opened',
                isError: false,
                stateChanging: true,
                screenshot: {
                    png: new Uint8Array([
                        1,
                        2,
                        3,
                    ]),
                    sha256: 'abc',
                    width: 1280,
                    height: 800,
                },
                report: null,
            })
            .mockResolvedValueOnce({
                content: 'reported',
                isError: false,
                stateChanging: false,
                screenshot: null,
                report: {
                    outcome: 'completed',
                    stepsDone: ['opened the document'],
                    problem: null,
                    slowestAction: null,
                    finalPage: 1,
                },
            });
        const {
            client,
            create,
        } = createClient([
            message([toolUse('t1', 'open_document', {path: '/fixtures/doc.pdf'})]),
            message([toolUse('t2', 'report', {
                outcome: 'completed',
                steps_done: ['opened the document'],
            })]),
        ]);
        const log = vi.fn();

        const result = await runStressOperatorScenario(buildOptions(client, {log}));

        expect(result.turns).toBe(2);
        expect(result.actions).toBe(2);
        expect(result.stopReason).toBe('report: completed');
        expect(result.report?.outcome).toBe('completed');
        expect(result.costUsd).toBeGreaterThan(0);
        expect(result.actionRecords.map(record => record.status)).toEqual([
            'succeeded',
            'succeeded',
        ]);
        expect(result.actionRecords[0]?.evidence?.screenshotSha256).toBe('abc');
        expect(mocks.executeStressOperatorTool).toHaveBeenCalledWith(expect.anything(), {
            toolsetName: null,
            name: 'open_document',
            input: {path: '/fixtures/doc.pdf'},
        });

        const request = create.mock.calls[0]?.[0];
        expect(request?.tools?.[0]).toEqual({type: 'computer_toolset_20260801'});
        expect(request?.system).toContain('Call report exactly once');

        const actions = await readJsonLines(result.artifacts.actions ?? '');
        expect(actions.map(record => record.status)).toEqual([
            'running',
            'succeeded',
            'running',
            'succeeded',
        ]);
        const transcript = await readJsonLines(result.artifacts.transcript ?? '');
        expect(transcript[0]).toMatchObject({
            turn: 0,
            role: 'user',
        });
        expect(transcript).toHaveLength(5);
        await expect(stat(join(scenarioDir, 'screenshots', '0001-open_document.png'))).resolves.toBeTruthy();
        expect(await readFile(result.artifacts.taskCard ?? '', 'utf8')).toContain(`TASK ${scenario.id}`);
    });

    it('nudges once for a missing report and then stops when the model still ends the turn', async () => {
        const {
            client,
            create,
        } = createClient([
            message([{
                type: 'text',
                text: 'Done.',
                citations: null,
            }], 'end_turn'),
            message([{
                type: 'text',
                text: 'Really done.',
                citations: null,
            }], 'end_turn'),
        ]);

        const result = await runStressOperatorScenario(buildOptions(client));

        expect(create).toHaveBeenCalledTimes(2);
        expect(result.stopReason).toBe('model ended the turn without calling report');
        expect(result.report).toBeNull();
        expect(result.actions).toBe(0);
        const request = create.mock.calls[1]?.[0];
        expect(request?.messages.some(entry => entry.role === 'user' && typeof entry.content === 'string' && entry.content.includes('You stopped without calling report'))).toBe(true);
    });

    it('turns an API failure into an api error stop reason with the HTTP status', async () => {
        const failure = Object.assign(new Error('rate limited'), {status: 429});
        const {client} = createClient([failure]);

        const result = await runStressOperatorScenario(buildOptions(client));

        expect(result.stopReason).toBe('api error 429: rate limited');
        expect(result.turns).toBe(1);
        expect(result.costUsd).toBe(0);
    });

    it('marks an unexecuted batch member failed after an earlier tool error', async () => {
        mocks.executeStressOperatorTool.mockResolvedValueOnce({
            content: 'path not allowed',
            isError: true,
            stateChanging: false,
            screenshot: null,
            report: null,
        });
        const {client} = createClient([
            message([
                toolUse('t1', 'open_document', {path: '/elsewhere.pdf'}),
                toolUse('t2', 'app_state', {}),
            ]),
            message([{
                type: 'text',
                text: 'giving up',
                citations: null,
            }], 'max_tokens'),
        ]);

        const result = await runStressOperatorScenario(buildOptions(client));

        expect(mocks.executeStressOperatorTool).toHaveBeenCalledTimes(1);
        expect(result.actionRecords.map(record => [
            record.tool,
            record.status,
        ])).toEqual([
            [
                'open_document',
                'failed',
            ],
            [
                'app_state',
                'failed',
            ],
        ]);
        expect(result.stopReason).toBe('model hit max_tokens without a tool call');
    });

    it('halts before the first request when the turn budget is already spent', async () => {
        const {
            client,
            create,
        } = createClient([]);

        const result = await runStressOperatorScenario(buildOptions(client, {budgets: {
            ...scenario.budgets,
            maxTurns: 0,
        }}));

        expect(create).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('turn budget of 0 exhausted');
        expect(result.turns).toBe(0);
    });
});
