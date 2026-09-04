import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    STRESS_REPLAY_USAGE,
    isStressCliEntrypoint,
    parseStressReplayCliOptions,
    runStressCliMain,
} from '@scripts/stress/stressCliOptions';
import {
    ensureStressFixtures,
    STRESS_FIXTURE_SPECS,
} from '@scripts/stress/stressFixtures';
import { resolveStressHostProfile } from '@scripts/stress/stressHostProfiles';
import type { IStressOperatorToolContext } from '@scripts/stress/stressOperatorToolExecutor';
import {
    parseReplayActions,
    planReplaySteps,
    replayStressActions,
} from '@scripts/stress/stressReplayDriver';
import { findStressScenario } from '@scripts/stress/stressScenarioRegistry';
import { startStressSession } from '@scripts/stress/stressSessionLifecycle';

const STEP_TIMEOUT_MS = 120_000;

export async function replayStress(argv: readonly string[]) {
    const options = parseStressReplayCliOptions(argv);
    if (options.help || !options.actionsPath) {
        console.log(STRESS_REPLAY_USAGE);
        return options.help ? 0 : 2;
    }
    const actionsPath = resolve(options.actionsPath);
    const records = parseReplayActions(await readFile(actionsPath, 'utf8'));
    const scenarioId = options.scenarioId ?? records[0]?.scenarioId ?? null;
    if (!scenarioId) {
        throw new Error('actions.jsonl has no records; pass --scenario to name the scenario');
    }
    const scenario = findStressScenario(scenarioId);
    if (!scenario) {
        throw new Error(`unknown scenario ${scenarioId}`);
    }
    const log = (line: string) => console.log(line);
    const fixtures = await ensureStressFixtures(scenario.fixtures, {log});
    const allowedPaths = new Map<string, {kind: 'pdf' | 'djvu'}>();
    for (const id of scenario.fixtures) {
        const record = fixtures.get(id);
        if (record?.available) {
            allowedPaths.set(record.path, {kind: STRESS_FIXTURE_SPECS[id].kind});
        }
    }
    const steps = planReplaySteps(records);
    log(`replaying ${steps.length} action(s) from ${actionsPath} for ${scenario.id}`);
    const profile = resolveStressHostProfile(options.profile);
    const handle = await startStressSession(`replay-${scenario.id}`, profile, log);
    try {
        const context: IStressOperatorToolContext = {
            session: handle.session,
            allowedPaths,
            viewport: {
                width: profile.deviceMetrics.width,
                height: profile.deviceMetrics.height,
            },
            stepTimeoutMs: STEP_TIMEOUT_MS,
            log,
        };
        const result = await replayStressActions(steps, context, log);
        log(`executed ${result.executed} action(s), ${result.divergences.length} divergence(s)`);
        for (const divergence of result.divergences) {
            log(`  seq ${divergence.seq} ${divergence.tool} ${divergence.kind}: ${divergence.detail}`);
        }
        return result.divergences.length === 0 ? 0 : 1;
    } finally {
        await handle.stop();
    }
}

if (isStressCliEntrypoint(import.meta.url)) {
    void runStressCliMain(replayStress);
}
