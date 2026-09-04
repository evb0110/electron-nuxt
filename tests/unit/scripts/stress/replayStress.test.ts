import {
    mkdtemp,
    rm,
    writeFile,
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
import { replayStress } from '@scripts/stress/replayStress';
import type * as TStressFixtures from '@scripts/stress/stressFixtures';
import type * as TStressReplayDriver from '@scripts/stress/stressReplayDriver';
import { STRESS_SCENARIOS } from '@scripts/stress/stressScenarioRegistry';
import type {
    IStressActionRecord,
    TStressScenario,
} from '@scripts/stress/stressTypes';

const mocks = vi.hoisted(() => ({
    ensureStressFixtures: vi.fn(),
    startStressSession: vi.fn(),
    replayStressActions: vi.fn(),
}));

vi.mock('@scripts/stress/stressFixtures', async importOriginal => ({
    ...await importOriginal<typeof TStressFixtures>(),
    ensureStressFixtures: mocks.ensureStressFixtures,
}));
vi.mock('@scripts/stress/stressSessionLifecycle', () => ({startStressSession: mocks.startStressSession}));
vi.mock('@scripts/stress/stressReplayDriver', async importOriginal => ({
    ...await importOriginal<typeof TStressReplayDriver>(),
    replayStressActions: mocks.replayStressActions,
}));

function requireOperatorScenario(): TStressScenario {
    const found = STRESS_SCENARIOS.find(candidate => candidate.kind === 'operator');
    if (!found) {
        throw new Error('registry has no operator scenario');
    }
    return found;
}

const scenario = requireOperatorScenario();

function record(overrides: Partial<IStressActionRecord>): IStressActionRecord {
    return {
        seq: 1,
        turn: 1,
        batchIndex: 0,
        runId: 'r',
        scenarioId: scenario.id,
        toolUseId: 'tu',
        toolsetName: null,
        tool: 'app_state',
        input: {},
        status: 'succeeded',
        startedAt: '2026-09-04T00:00:00.000Z',
        completedAt: null,
        durationMs: 1,
        tOffsetMs: 0,
        error: null,
        evidence: null,
        ...overrides,
    };
}

let workDir = '';
let actionsPath = '';

describe('replayStress main', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        workDir = await mkdtemp(join(tmpdir(), 'stress-replay-'));
        actionsPath = join(workDir, 'actions.jsonl');
        const fixturePath = join(workDir, 'fixture.pdf');
        await writeFile(fixturePath, '%PDF-1.4\n', 'utf8');
        mocks.ensureStressFixtures.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [
            id,
            {
                id,
                path: fixturePath,
                bytes: 9,
                specHash: 'h',
                generatedAt: '2026-09-04T00:00:00.000Z',
                available: true,
                reason: null,
            },
        ])));
        mocks.startStressSession.mockResolvedValue({
            session: {page: {}},
            stop: vi.fn(async () => ({leakedPids: []})),
        });
        mocks.replayStressActions.mockResolvedValue({
            executed: 1,
            divergences: [],
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(workDir, {
            recursive: true,
            force: true,
        });
    });

    it('prints usage for --help and for a missing --actions path', async () => {
        expect(await replayStress(['--help'])).toBe(0);
        expect(await replayStress([])).toBe(2);
        expect(mocks.startStressSession).not.toHaveBeenCalled();
    });

    it('refuses an empty recording and an unknown scenario', async () => {
        await writeFile(actionsPath, '', 'utf8');
        await expect(replayStress([
            '--actions',
            actionsPath,
        ])).rejects.toThrow('no records');
        await expect(replayStress([
            '--actions',
            actionsPath,
            '--scenario',
            'nope',
        ])).rejects.toThrow('unknown scenario nope');
    });

    it('replays the recording against a fresh session and exits 0 without divergences', async () => {
        await writeFile(actionsPath, `${JSON.stringify(record({seq: 1}))}\n`, 'utf8');
        const code = await replayStress([
            '--actions',
            actionsPath,
            '--profile',
            'slow-a',
        ]);

        expect(code).toBe(0);
        expect(mocks.startStressSession).toHaveBeenCalledWith(`replay-${scenario.id}`, expect.objectContaining({id: 'slow-a'}), expect.any(Function));
        const [
            steps,
            context,
        ] = mocks.replayStressActions.mock.calls[0] as [unknown[], {
            allowedPaths: Map<string, unknown>;
            viewport: {width: number}
        }];
        expect(steps).toHaveLength(1);
        expect(context.allowedPaths.size).toBe(scenario.fixtures.length);
        expect(context.viewport.width).toBeGreaterThan(0);
        const handle = await mocks.startStressSession.mock.results[0]?.value as {stop: ReturnType<typeof vi.fn>};
        expect(handle.stop).toHaveBeenCalledTimes(1);
    });

    it('exits 1 and still stops the session when the replay diverges', async () => {
        await writeFile(actionsPath, `${JSON.stringify(record({seq: 1}))}\n`, 'utf8');
        mocks.replayStressActions.mockResolvedValue({
            executed: 1,
            divergences: [{
                seq: 1,
                tool: 'app_state',
                kind: 'app-state',
                detail: 'page differs',
            }],
        });

        expect(await replayStress([
            '--actions',
            actionsPath,
        ])).toBe(1);
        const handle = await mocks.startStressSession.mock.results[0]?.value as {stop: ReturnType<typeof vi.fn>};
        expect(handle.stop).toHaveBeenCalledTimes(1);
    });
});
