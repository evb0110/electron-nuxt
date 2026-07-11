import {
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { difference } from 'es-toolkit/array';
import {
    AVAILABLE_OCR_LANGUAGES,
    BUNDLED_OCR_LANGUAGE_CODES,
} from '@contracts/ocrLanguages';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const tessdataDirectory = path.join(projectRoot, 'resources', 'tesseract', 'tessdata');
const electronBuilderConfigPath = path.join(projectRoot, 'electron-builder.yml');

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

const bundledCodes = [...BUNDLED_OCR_LANGUAGE_CODES].sort();
const unsupportedBundledModels = difference(bundledCodes, registryCodes);
const missingBundledModels = difference(bundledCodes, tessdataCodes);
if (unsupportedBundledModels.length > 0 || missingBundledModels.length > 0) {
    console.error('Bundled OCR language defaults are invalid.');
    console.error(`  Defaults absent from supported registry: ${formatList(unsupportedBundledModels)}`);
    console.error(`  Defaults absent from tessdata_best resources: ${formatList(missingBundledModels)}`);
    process.exit(1);
}

const electronBuilderConfig = readFileSync(electronBuilderConfigPath, 'utf8');
const tessdataResourceBlock = electronBuilderConfig.match(
    /- from: resources\/tesseract\/tessdata\n\s+to: tesseract\/tessdata\n\s+filter:\n((?:\s+- [a-z0-9_]+\.traineddata\n?)+)/u,
);
const packagedCodes = tessdataResourceBlock?.[1]
    ?.match(/[a-z0-9_]+(?=\.traineddata)/gu)
    ?.sort() ?? [];
if (JSON.stringify(packagedCodes) !== JSON.stringify(bundledCodes)) {
    console.error('electron-builder tessdata filter does not match bundled OCR defaults.');
    console.error(`  Expected packaged defaults: ${formatList(bundledCodes)}`);
    console.error(`  Configured package filter: ${formatList(packagedCodes)}`);
    process.exit(1);
}

console.log(
    `OK OCR registry supports ${registryCodes.length} tessdata_best languages; `
    + `package defaults are ${bundledCodes.join(', ')}.`,
);
