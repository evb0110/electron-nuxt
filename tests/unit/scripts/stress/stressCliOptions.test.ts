import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseStressCliOptions,
    parseStressReplayCliOptions,
} from '@scripts/stress/stressCliOptions';
import { DEFAULT_STRESS_OPERATOR_MODEL } from '@scripts/stress/stressOperatorCost';

describe('parseStressCliOptions', () => {
    it('defaults to every scenario on the baseline profile with the default model', () => {
        const options = parseStressCliOptions([]);
        expect(options.profile).toBe('baseline');
        expect(options.model).toBe(DEFAULT_STRESS_OPERATOR_MODEL);
        expect(options.operatorProfile).toBe('pixel');
        expect(options.scenarioIds).toEqual([]);
        expect(options.maxRunCostUsd).toBeNull();
        expect(options.dryRun).toBe(false);
    });

    it('accepts repeated and comma-separated values plus --flag=value', () => {
        const options = parseStressCliOptions([
            '--scenario',
            'a,b',
            '--scenario=c',
            '--tag',
            'memory',
            '--profile=slow-a',
            '--operator',
            'semantic',
            '--max-run-cost',
            '12.5',
            '--thinking',
            '--out',
            '/tmp/run',
        ]);
        expect(options.scenarioIds).toEqual([
            'a',
            'b',
            'c',
        ]);
        expect(options.tags).toEqual(['memory']);
        expect(options.profile).toBe('slow-a');
        expect(options.operatorProfile).toBe('semantic');
        expect(options.maxRunCostUsd).toBe(12.5);
        expect(options.thinking).toBe(true);
        expect(options.out).toBe('/tmp/run');
    });

    it('rejects typos, bad enums and missing values', () => {
        expect(() => parseStressCliOptions([
            '--scenari',
            'x',
        ])).toThrow(/unknown option/u);
        expect(() => parseStressCliOptions([
            '--kind',
            'fuzzy',
        ])).toThrow(/--kind/u);
        expect(() => parseStressCliOptions([
            '--profile',
            'fast',
        ])).toThrow(/unknown --profile/u);
        expect(() => parseStressCliOptions([
            '--operator',
            'voice',
        ])).toThrow(/--operator/u);
        expect(() => parseStressCliOptions([
            '--max-run-cost',
            '-1',
        ])).toThrow(/non-negative/u);
        expect(() => parseStressCliOptions(['--scenario'])).toThrow(/needs a value/u);
        expect(() => parseStressCliOptions([
            '--scenario',
            '--list',
        ])).toThrow(/needs a value/u);
    });

    it('recognises the informational modes', () => {
        expect(parseStressCliOptions(['--help']).help).toBe(true);
        expect(parseStressCliOptions(['-h']).help).toBe(true);
        expect(parseStressCliOptions(['--list']).list).toBe(true);
        expect(parseStressCliOptions(['--fixtures-only']).fixturesOnly).toBe(true);
        expect(parseStressCliOptions(['--calibrate-only']).calibrateOnly).toBe(true);
        expect(parseStressCliOptions(['--update-baseline']).updateBaseline).toBe(true);
    });
});

describe('parseStressReplayCliOptions', () => {
    it('reads the actions path, profile and scenario', () => {
        const options = parseStressReplayCliOptions([
            '--actions',
            'a.jsonl',
            '--profile=slow-b',
            '--scenario',
            'tab-storm',
        ]);
        expect(options).toEqual({
            actionsPath: 'a.jsonl',
            profile: 'slow-b',
            scenarioId: 'tab-storm',
            help: false,
        });
    });

    it('rejects unknown flags and profiles', () => {
        expect(() => parseStressReplayCliOptions([
            '--actions',
            'a',
            '--bogus',
        ])).toThrow(/unknown option/u);
        expect(() => parseStressReplayCliOptions([
            '--profile',
            'nope',
        ])).toThrow(/unknown --profile/u);
        expect(parseStressReplayCliOptions([]).actionsPath).toBeNull();
    });
});
