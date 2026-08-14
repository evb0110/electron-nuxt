import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IThresholdBaseline {
    count: number;
    generatedBy: string;
}

interface IThresholdBaselineModule {
    canonicalThresholdBaselineJson: () => Promise<string>;
    countNamedFloatConsts: () => Promise<number>;
    thresholdBaselineGenerator: string;
    thresholdBaselinePath: string;
}

const thresholdModule = await import(pathToFileURL(resolve(
    process.cwd(),
    'scripts/architecture/generate-scan-cleanup-threshold-baseline.mjs',
)).href) as IThresholdBaselineModule;

describe('scan-cleanup threshold count policy', () => {
    it('requires regeneration whenever the production f32/f64 item count changes', async () => {
        const committed = await readFile(thresholdModule.thresholdBaselinePath, 'utf8');
        const baseline = JSON.parse(committed) as IThresholdBaseline;
        const currentCount = await thresholdModule.countNamedFloatConsts();
        const regenerationMessage = `Run ${thresholdModule.thresholdBaselineGenerator} to regenerate the baseline.`;

        expect(Number.isSafeInteger(baseline.count)).toBe(true);
        expect(currentCount, regenerationMessage).toBe(baseline.count);
        expect(committed, regenerationMessage).toBe(
            await thresholdModule.canonicalThresholdBaselineJson(),
        );
    });
});
