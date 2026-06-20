import { readFileSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';

const OCR_LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
    eng: 'English',
    fra: 'French',
    deu: 'German',
    tur: 'Turkish',
    ell: 'Greek',
    grc: 'Ancient Greek',
    kmr: 'Kurdish (Kurmanji)',
    rus: 'Russian',
    ara: 'Arabic',
    heb: 'Hebrew',
    syr: 'Syriac',
};

function getReadmeOcrLanguageSection(readme: string) {
    const match = /### OCR Languages\n\n([\s\S]*?)(?:\n### |\n## )/u.exec(readme);
    if (!match?.[1]) {
        throw new Error('README OCR Languages section was not found');
    }
    return match[1];
}

function getDisplayName(code: string) {
    if (!(code in OCR_LANGUAGE_DISPLAY_NAMES)) {
        throw new Error(`Missing README display-name expectation for OCR language ${code}`);
    }
    return OCR_LANGUAGE_DISPLAY_NAMES[code];
}

describe('OCR documentation', () => {
    it('keeps README OCR language list aligned with the registry', () => {
        const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');
        const section = getReadmeOcrLanguageSection(readme);

        for (const language of AVAILABLE_OCR_LANGUAGES) {
            expect(section).toContain(`- ${getDisplayName(language.code)}`);
        }
    });

    it('documents the shipped OCR profile names in the benchmark notes', () => {
        const ocrNotes = readFileSync(join(process.cwd(), 'docs/ocr.md'), 'utf-8');

        expect(ocrNotes).toContain('`balanced`');
        expect(ocrNotes).toContain('`accurate`');
        expect(ocrNotes).toContain('`poor-scan`');
        expect(ocrNotes).toContain('`stock`');
    });
});
