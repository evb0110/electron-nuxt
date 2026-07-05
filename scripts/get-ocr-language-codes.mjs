import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVAILABLE_OCR_LANGUAGES } from '../packages/contracts/ocrLanguages.ts';

export function getOcrLanguageCodes() {
    return AVAILABLE_OCR_LANGUAGES
        .map(language => language.code)
        .sort();
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const codes = getOcrLanguageCodes();
    if (codes.length === 0) {
        console.error('No OCR language codes found in AVAILABLE_OCR_LANGUAGES');
        process.exit(1);
    }
    process.stdout.write(codes.join(process.argv.includes('--space-separated') ? ' ' : '\n'));
}
