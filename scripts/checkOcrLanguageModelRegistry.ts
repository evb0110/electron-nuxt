import {
    existsSync,
    readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { difference } from 'es-toolkit/array';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const tessdataDirectory = path.join(projectRoot, 'resources', 'tesseract', 'tessdata');

function formatList(values: readonly string[]) {
    return values.length > 0 ? values.join(', ') : '(none)';
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
const missingModels = difference(registryCodes, tessdataCodes);
const unregisteredModels = difference(tessdataCodes, registryCodes);

if (missingModels.length > 0 || unregisteredModels.length > 0) {
    console.error('OCR language registry and bundled tessdata are out of sync.');
    console.error(`  Missing traineddata for registry codes: ${formatList(missingModels)}`);
    console.error(`  Unregistered traineddata files: ${formatList(unregisteredModels)}`);
    process.exit(1);
}

console.log(`OK OCR language registry matches bundled tessdata (${registryCodes.length} languages)`);
