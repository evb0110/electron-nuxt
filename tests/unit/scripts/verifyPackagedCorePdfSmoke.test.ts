import {
    describe,
    expect,
    it,
} from 'vitest';
import {assertNoPackagedRendererFailures} from '@scripts/release/assertNoPackagedRendererFailures';

describe('packaged core PDF smoke renderer failure policy', () => {
    it('accepts a renderer journey with no errors', () => {
        expect(() => assertNoPackagedRendererFailures([])).not.toThrow();
    });

    it('fails the packaged smoke for console and page errors', () => {
        expect(() => assertNoPackagedRendererFailures([
            '[packaged-renderer:error] failed to load workspace',
            '[packaged-renderer:pageerror] Error: render crashed',
        ])).toThrow(/reported 2 error\(s\).*failed to load workspace.*render crashed/su);
    });
});
