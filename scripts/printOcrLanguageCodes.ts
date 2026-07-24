import {
    AVAILABLE_OCR_LANGUAGES,
    BUNDLED_OCR_LANGUAGE_CODES,
    OCR_LANGUAGE_MODEL_SHA256,
} from '@contracts/ocrLanguages';

const separator = process.argv.includes('--space') ? ' ' : '\n';
const codes = (process.argv.includes('--bundled')
    ? [...BUNDLED_OCR_LANGUAGE_CODES]
    : AVAILABLE_OCR_LANGUAGES.map(language => language.code))
    .sort();

if (codes.length === 0) {
    throw new Error('No OCR language codes are registered.');
}

process.stdout.write(process.argv.includes('--sha256')
    ? codes.map((code) => {
        const sha256 = OCR_LANGUAGE_MODEL_SHA256[code];
        if (!sha256) {
            throw new Error(`No SHA-256 digest is registered for OCR language ${code}.`);
        }
        return `${code} ${sha256}`;
    }).join('\n')
    : codes.join(separator));
