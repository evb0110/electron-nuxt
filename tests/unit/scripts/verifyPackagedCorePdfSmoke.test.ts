import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertNoPackagedRendererFailures} from '@scripts/release/assertNoPackagedRendererFailures';

const packagedSmokeSource = readFileSync(
    resolve(process.cwd(), 'scripts/release/verifyPackagedCorePdfSmoke.ts'),
    'utf8',
);

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

    it('waits for a usable canonical text-box editor before typing', () => {
        expect(packagedSmokeSource).toContain('createCanonicalTextBoxWithPointer');
        expect(packagedSmokeSource).not.toContain('createFreeTextAnnotation(page, annotationText)');
    });
});
