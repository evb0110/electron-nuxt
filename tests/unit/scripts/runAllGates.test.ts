import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IGateDefinition {
    args: string[];
    command: string;
    id: string;
}

interface IRunAllGatesModule {
    getAllGateDefinitions: () => IGateDefinition[];
    getAllGateEnvironment: (gateId: string, options: {
        baseEnv?: Record<string, string>;
        receiptPath: string;
        receiptReady: boolean;
    }) => Record<string, string>;
}

interface IStageBatchModule {runStageBatches: <T extends {parallelPhase?: number}>(
    stages: T[],
    runStage: (stage: T) => Promise<void>,
) => Promise<void>;}

const runner = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/run-all-gates.mjs'),
).href) as IRunAllGatesModule;
const {runStageBatches} = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/run-stage-batches.mjs'),
).href) as IStageBatchModule;

describe('all-gates orchestration', () => {
    it('uses one consolidated validation phase before release verification', () => {
        expect(runner.getAllGateDefinitions().map(gate => gate.id)).toEqual([
            'validate',
            'release-verify',
            'release-cut-preflight',
        ]);
    });

    it('reuses validation evidence only when this invocation produced it', () => {
        const withoutReceipt = runner.getAllGateEnvironment('release-verify', {
            baseEnv: {},
            receiptPath: '/tmp/receipt.json',
            receiptReady: false,
        });
        const withReceipt = runner.getAllGateEnvironment('release-verify', {
            baseEnv: {},
            receiptPath: '/tmp/receipt.json',
            receiptReady: true,
        });

        expect(withoutReceipt).not.toHaveProperty('EVB_RELEASE_VERIFY_SKIP');
        expect(withReceipt).toMatchObject({
            EVB_RELEASE_BUILD_RECEIPT: '/tmp/receipt.json',
            EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
            EVB_RELEASE_VERIFY_SKIP_ACK: '1',
        });
        expect(withReceipt.EVB_RELEASE_VERIFY_SKIP?.split(',')).toEqual(expect.arrayContaining([
            'lint:clean',
            'test:coverage',
            'test:rust',
            'test:electron-bundle-static-integrity',
        ]));
    });

    it('overlaps only adjacent stages in the same declared phase', async () => {
        const events: string[] = [];
        let active = 0;
        let maxActive = 0;
        await runStageBatches([
            {
                id: 'lint',
                parallelPhase: 0,
            },
            {
                id: 'coverage',
                parallelPhase: 0,
            },
            {
                id: 'build',
                parallelPhase: 1,
            },
        ], async stage => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            events.push(`start:${stage.id}`);
            await Promise.resolve();
            events.push(`end:${stage.id}`);
            active -= 1;
        });

        expect(maxActive).toBe(2);
        expect(events.indexOf('start:build')).toBeGreaterThan(events.indexOf('end:coverage'));
    });
});
