import {
    mkdirSync,
    mkdtempSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IPayloadPolicyModule {verifyWindowsTesseractPayload: (options: {
    binDirectory: string;
    limits: {
        totalBytes: number;
        libtesseractBytes: number;
        icuDataBytes: number;
    };
}) => {
    errors: string[];
    measurement: { totalBytes: number }
};}

const { verifyWindowsTesseractPayload } = await import(pathToFileURL(join(
    process.cwd(),
    'scripts/release/windows-tesseract-payload-policy.mjs',
)).href) as IPayloadPolicyModule;

function fixture(files: Record<string, number>) {
    const directory = join(mkdtempSync(join(tmpdir(), 'evb-win-tess-payload-')), 'bin');
    mkdirSync(directory);
    for (const [
        name,
        bytes,
    ] of Object.entries(files)) writeFileSync(join(directory, name), Buffer.alloc(bytes));
    return directory;
}

describe('Windows Tesseract payload policy', () => {
    it('measures and accepts a payload within every budget', () => {
        const result = verifyWindowsTesseractPayload({
            binDirectory: fixture({
                'tesseract.exe': 4,
                'libtesseract-5.dll': 10,
                'libicudt75.dll': 5,
            }),
            limits: {
                totalBytes: 20,
                libtesseractBytes: 10,
                icuDataBytes: 5,
            },
        });
        expect(result.errors).toEqual([]);
        expect(result.measurement.totalBytes).toBe(19);
    });

    it('rejects total, engine, and ICU data regressions independently', () => {
        const result = verifyWindowsTesseractPayload({
            binDirectory: fixture({
                'libtesseract-5.dll': 11,
                'libicudt75.dll': 6,
                'other.dll': 4,
            }),
            limits: {
                totalBytes: 20,
                libtesseractBytes: 10,
                icuDataBytes: 5,
            },
        });
        expect(result.errors).toHaveLength(3);
        expect(result.errors.join('\n')).toContain('Tesseract payload');
        expect(result.errors.join('\n')).toContain('libtesseract-5.dll');
        expect(result.errors.join('\n')).toContain('libicudt75.dll');
    });
});
