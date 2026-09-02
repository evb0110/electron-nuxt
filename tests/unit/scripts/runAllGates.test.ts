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

interface IStagePoolModule {runStagePool: <T extends {
    dependsOn?: string[];
    id: string;
    weight?: number
}>(
    stages: T[],
    runStage: (stage: T) => Promise<void>,
    options?: {capacity?: number},
) => Promise<void>;}

const runner = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/run-all-gates.mjs'),
).href) as IRunAllGatesModule;
const {runStagePool} = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/validation-gates.mjs'),
).href) as IStagePoolModule;

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
        });
        expect(withReceipt).not.toHaveProperty('EVB_RELEASE_VERIFY_SKIP');
    });

    it('runs independent stages while releasing weighted capacity for dependents', async () => {
        const events: string[] = [];
        let activeWeight = 0;
        let maxActiveWeight = 0;
        await runStagePool([
            {
                id: 'lint',
                weight: 2,
            },
            {
                id: 'coverage',
                weight: 1,
            },
            {
                id: 'build',
                dependsOn: ['lint'],
                weight: 2,
            },
        ], async stage => {
            activeWeight += stage.weight ?? 1;
            maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
            events.push(`start:${stage.id}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            events.push(`end:${stage.id}`);
            activeWeight -= stage.weight ?? 1;
        }, {capacity: 2});

        expect(maxActiveWeight).toBeLessThanOrEqual(2);
        expect(events.indexOf('start:build')).toBeGreaterThan(events.indexOf('end:lint'));
    });
});
