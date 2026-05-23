import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

function extractRegistryLanguageCodes(source: string) {
    return [...source.matchAll(/code:\s*'([^']+)'/g)].map(match => match[1]);
}

describe('download-tessdata.sh', () => {
    it('derives tessdata languages from the canonical OCR registry', () => {
        const projectRoot = process.cwd();
        const registrySource = readFileSync(join(projectRoot, 'packages/contracts/ocrLanguages.ts'), 'utf8');
        const scriptSource = readFileSync(join(projectRoot, 'scripts/download-tessdata.sh'), 'utf8');

        expect(extractRegistryLanguageCodes(registrySource)).toEqual([
            'eng',
            'fra',
            'deu',
            'tur',
            'ell',
            'grc',
            'kmr',
            'rus',
            'ara',
            'heb',
            'syr',
        ]);
        expect(scriptSource).toContain('packages/contracts/ocrLanguages.ts');
        expect(scriptSource).toContain('source.matchAll(languageCodePattern)');
    });
});
