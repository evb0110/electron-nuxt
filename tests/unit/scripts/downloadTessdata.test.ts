import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AVAILABLE_OCR_LANGUAGES,
    OCR_LANGUAGE_MODEL_SHA256,
} from '@contracts/ocrLanguages';

function extractRegistryLanguageCodes(source: string) {
    return [...source.matchAll(/code:\s*'([^']+)'/g)].map(match => match[1]);
}

describe('download-tessdata.sh', () => {
    it('derives tessdata languages from the canonical OCR registry', () => {
        const projectRoot = process.cwd();
        const registrySource = readFileSync(join(projectRoot, 'packages/contracts/ocrLanguages.ts'), 'utf8');
        const scriptSource = readFileSync(join(projectRoot, 'scripts/download-tessdata.sh'), 'utf8');

        expect(extractRegistryLanguageCodes(registrySource)).toEqual(
            AVAILABLE_OCR_LANGUAGES.map(language => language.code),
        );
        expect(registrySource.match(/[a-f0-9]{64}/gu)).toHaveLength(
            Object.keys(OCR_LANGUAGE_MODEL_SHA256).length,
        );
        expect(scriptSource).toContain('packages/contracts/ocrLanguages.ts');
        expect(scriptSource).toContain('source.matchAll(languageCodePattern)');
        expect(scriptSource).toContain('TESSDATA_BEST_REF="e12c65a915945e4c28e237a9b52bc4a8f39a0cec"');
        expect(scriptSource).toContain('raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_REF}');
        expect(scriptSource).toContain('curl --fail --location --show-error --silent --retry 3');
        expect(scriptSource).toContain('[ ! -s "$TMP_FILE" ]');
        expect(scriptSource).toContain('[ "$bytes" -lt 1024 ]');
        expect(scriptSource).toContain('printOcrLanguageCodes.ts --sha256');
        expect(scriptSource).toContain('tessdata SHA-256 mismatch for $lang');
    });
});
