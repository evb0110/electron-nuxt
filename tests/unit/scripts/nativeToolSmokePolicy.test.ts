import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    assertMacPackagedToolSmoke,
    getMacPackagedToolSmokePolicy,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href);

describe('native tool smoke policy', () => {
    it('keeps mac packaged tool smoke expectations explicit per tool', () => {
        const verifierSource = readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf-8');
        const verifierTools = Array.from(
            verifierSource.matchAll(/run_macos_packaged_tool_smoke "([^"]+)"/gu),
            match => match[1],
        );
        const expectedPolicies = new Map<string, Set<number>>([
            [
                'ddjvu',
                new Set([
                    0,
                    1,
                    10,
                ]),
            ],
            [
                'djvused',
                new Set([
                    0,
                    10,
                ]),
            ],
            [
                'djvudump',
                new Set([
                    0,
                    1,
                    10,
                ]),
            ],
            [
                'evb-pdf-image-combine',
                new Set([0]),
            ],
            [
                'evb-pdf-image-combine-protocol',
                new Set([0]),
            ],
            [
                'evb-pdf-image-combine-compact-manifest',
                new Set([1]),
            ],
            [
                'evb-pdf-page-ops',
                new Set([0]),
            ],
            [
                'evb-pdf-search',
                new Set([0]),
            ],
            [
                'pdfinfo',
                new Set([0]),
            ],
            [
                'pdftoppm',
                new Set([0]),
            ],
            [
                'pdftotext',
                new Set([0]),
            ],
            [
                'qpdf',
                new Set([0]),
            ],
            [
                'tesseract',
                new Set([0]),
            ],
            [
                'unpaper',
                new Set([0]),
            ],
        ]);

        expect(verifierTools.sort()).toEqual(Array.from(expectedPolicies.keys()).sort());
        for (const [
            toolName,
            allowedExitCodes,
        ] of expectedPolicies) {
            expect(getMacPackagedToolSmokePolicy(toolName).allowedExitCodes).toEqual(allowedExitCodes);
        }
    });

    it('requires both an allowed exit code and recognizable output', () => {
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'qpdf version 12.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdfinfo', 0, 'pdfinfo version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdftoppm', 0, 'pdftoppm version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('pdftotext', 0, 'pdftotext version 25.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('tesseract', 0, 'tesseract 5.5.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-protocol', 0, '3')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-page-ops', 0, 'evb-pdf-page-ops 0.1.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-search', 0, 'evb-pdf-search 0.1.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Missing --compact-manifest value')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('ddjvu', 1, 'ddjvu usage')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('djvudump', 1, 'djvudump usage')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('unpaper', 0, 'Usage: unpaper [options]')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('qpdf', 2, 'qpdf version 12.0.0')).toThrow(
            'Packaged tool smoke test failed (qpdf) with exit code 2',
        );
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'unexpected output')).toThrow(
            'Packaged tool smoke test output for qpdf did not match any expected signature',
        );
        expect(() => assertMacPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Unknown argument: --compact-manifest')).toThrow(
            'Packaged tool smoke test output for evb-pdf-image-combine-compact-manifest did not match any expected signature',
        );
    });

    it('keeps packaged OCR verification production-like and default-bundle complete', () => {
        const verifierSource = readFileSync(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf-8');

        expect(verifierSource).toContain('verify_tessdata_bundle_complete "$tessdata_dir"');
        expect(verifierSource).toContain('printOcrLanguageCodes.ts --bundled');
        expect(verifierSource).toContain('get_bundled_language_codes');
        expect(verifierSource).not.toContain('DYLD_LIBRARY_PATH=');
        expect(verifierSource).not.toContain('LD_LIBRARY_PATH=');
        expect(verifierSource).toContain('windows-pe-dependencies.mjs');
        expect(verifierSource).not.toContain('objdump -p');
        expect(verifierSource).toContain('run_host_packaged_tool_smoke "tesseract" "tesseract"');
        expect(verifierSource).toContain('run_host_packaged_tool_smoke "unpaper" "unpaper|usage"');
        expect(verifierSource).toContain('Windows unpaper preprocessing is explicitly unavailable');
    });
});
