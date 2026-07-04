import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';

const separator = process.argv.includes('--space') ? ' ' : '\n';
const codes = AVAILABLE_OCR_LANGUAGES
    .map(language => language.code)
    .sort();

if (codes.length === 0) {
    throw new Error('No OCR language codes are registered.');
}

process.stdout.write(codes.join(separator));
