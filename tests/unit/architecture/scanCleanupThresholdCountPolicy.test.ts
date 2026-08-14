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
    countNamedFloatConstsInSource: (source: string) => number;
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

    it('counts every documented declaration form and nothing else', () => {
        const count = thresholdModule.countNamedFloatConstsInSource;
        expect(count('const GAIN: f64 = 1.0;')).toBe(1);
        expect(count('pub const GAIN: f32 = 1.0;')).toBe(1);
        expect(count('pub(crate) static FLOOR: f64 = 0.5;')).toBe(1);
        expect(count('static mut LEVEL: f64 = 0.5;')).toBe(1);
        expect(count('const DEPTHS: [f64; 5] = [0.0; 5];')).toBe(1);
        expect(count('const PAIRS: &[(f64, f64)] = &[];')).toBe(1);
        expect(count('// const HIDDEN: f64 = 1.0;')).toBe(0);
        expect(count('/* const HIDDEN: f64 = 1.0; */')).toBe(0);
        expect(count('let x = y as f64;')).toBe(0);
        expect(count('const LABEL: &str = "f64";')).toBe(0);
    });
});
