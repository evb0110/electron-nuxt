import {
    describe,
    expect,
    it,
} from 'vitest';
import {
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
