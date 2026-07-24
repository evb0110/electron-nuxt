import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildSavePipelineBenchmarkReport,
    parseSavePipelineBenchmarkArgs,
    validateSavePipelineBenchmarkOptions,
} from '@scripts/benchmark-save-pipeline.mjs';

describe('benchmark-save-pipeline', () => {
    it('parses the documented benchmark options', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--fixture',
            '/tmp/input.pdf',
            '--iterations',
            '7',
            '--output',
            '.devkit/analysis/save.json',
            '--warmups',
            '3',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 7,
            output: '.devkit/analysis/save.json',
            warmups: 3,
        });
    });

    it('accepts the wp6 diagnostic input and output aliases', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--pdf',
            '/tmp/input.pdf',
            '--out',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
    });

    it('ignores the leading -- separator that pnpm forwards for both alias forms', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--',
            '--fixture',
            '/tmp/input.pdf',
            '--output',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
        expect(parseSavePipelineBenchmarkArgs([
            '--',
            '--pdf',
            '/tmp/input.pdf',
            '--out',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
    });

    it('pins the report contract the e2e scenarios feed into', () => {
        const scenario = {
            schemaVersion: 1,
            scenario: 'native-freetext-high',
            mode: 'native-freetext',
            tier: 'high',
            hostProfile: {tier: 'high'},
            fixturePath: '/tmp/input.pdf',
            inputPath: '/tmp/input.pdf',
            outputPath: '/tmp/out.json.native-freetext-high.pdf',
            warmups: 5,
            iterations: 10,
            iterationMeasurements: [{
                iteration: 1,
                afterBytes: 2048,
                beforeBytes: 1024,
                durationMs: 12.5,
                timestamp: '2026-07-25T00:00:00.000Z',
            }],
            totalMs: {
                p50: 12.5,
                p95: 18.5,
                samples: [
                    12.5,
                    18.5,
                ],
            },
            peakRssBytes: 4096,
            inputBytes: 1024,
            outputBytes: 2048,
            outputSha256: 'a'.repeat(64),
            semanticReopen: {annotations: 1},
        };
        const report = buildSavePipelineBenchmarkReport(
            {
                fixture: '/tmp/input.pdf',
                iterations: 10,
                output: '/tmp/out.json',
                warmups: 5,
            },
            [scenario],
            {
                fixtureBytes: 1024,
                generatedAt: '2026-07-25T00:00:00.000Z',
            },
        );
        expect(report).toEqual({
            schemaVersion: 1,
            generatedAt: '2026-07-25T00:00:00.000Z',
            fixturePath: '/tmp/input.pdf',
            fixtureBytes: 1024,
            inputPath: '/tmp/input.pdf',
            outputPath: '/tmp/out.json',
            warmups: 5,
            iterations: 10,
            hostProfile: {tier: 'high'},
            hostTier: 'high',
            cloneMode: {
                measured: 'auto',
                forcedNoClone: 'unavailable',
            },
            scenarios: [scenario],
        });
        const [reportedScenario] = report.scenarios;
        expect(reportedScenario.totalMs).toEqual({
            p50: 12.5,
            p95: 18.5,
            samples: [
                12.5,
                18.5,
            ],
        });
        expect(reportedScenario.iterationMeasurements).toHaveLength(1);
        expect(reportedScenario.peakRssBytes).toBe(4096);
        expect(reportedScenario.outputBytes).toBe(2048);
        expect(reportedScenario.outputSha256).toHaveLength(64);
        expect(reportedScenario.semanticReopen).toEqual({annotations: 1});
    });

    it('derives a null host tier when the scenario omits a host profile', () => {
        const report = buildSavePipelineBenchmarkReport(
            {
                fixture: '/tmp/input.pdf',
                iterations: 10,
                output: '/tmp/out.json',
                warmups: 5,
            },
            [{hostProfile: null}],
            {
                fixtureBytes: 1024,
                generatedAt: '2026-07-25T00:00:00.000Z',
            },
        );
        expect(report.hostProfile).toBeNull();
        expect(report.hostTier).toBeNull();
    });

    it('requires an absolute fixture and positive run counts', () => {
        expect(() => validateSavePipelineBenchmarkOptions({
            fixture: 'relative.pdf',
            iterations: 10,
            output: 'result.json',
            warmups: 5,
        })).toThrow('--fixture must be an absolute PDF path');
        expect(() => validateSavePipelineBenchmarkOptions({
            fixture: '/tmp/input.pdf',
            iterations: 0,
            output: 'result.json',
            warmups: 5,
        })).toThrow('--iterations must be a positive integer');
    });

    it('rejects unknown options', () => {
        expect(() => parseSavePipelineBenchmarkArgs(['--unknown']))
            .toThrow('Unknown benchmark option: --unknown');
    });
});
