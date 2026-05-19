import {
    existsSync,
    readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVAILABLE_OCR_LANGUAGES } from '../packages/contracts/ocrLanguages';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const tessdataDirectory = path.join(projectRoot, 'resources', 'tesseract', 'tessdata');

function formatList(values: readonly string[]): string {
    return values.length > 0 ? values.join(', ') : '(none)';
}

function diff(left: readonly string[], right: readonly string[]): string[] {
    const rightValues = new Set(right);

    return left.filter(value => !rightValues.has(value));
}

function getRegistryCodes(): string[] {
    return AVAILABLE_OCR_LANGUAGES
        .map(language => language.code)
        .sort();
}

function getTessdataCodes(): string[] {
    if (!existsSync(tessdataDirectory)) {
        throw new Error(`Missing tessdata directory: ${path.relative(projectRoot, tessdataDirectory)}`);
    }

    return readdirSync(tessdataDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.traineddata'))
        .map(entry => entry.name.slice(0, -'.traineddata'.length))
        .sort();
}

const registryCodes = getRegistryCodes();
const tessdataCodes = getTessdataCodes();
const missingModels = diff(registryCodes, tessdataCodes);
const unregisteredModels = diff(tessdataCodes, registryCodes);

if (missingModels.length > 0 || unregisteredModels.length > 0) {
    console.error('OCR language registry and bundled tessdata are out of sync.');
    console.error(`  Missing traineddata for registry codes: ${formatList(missingModels)}`);
    console.error(`  Unregistered traineddata files: ${formatList(unregisteredModels)}`);
    process.exit(1);
}

console.log(`OK OCR language registry matches bundled tessdata (${registryCodes.length} languages)`);
