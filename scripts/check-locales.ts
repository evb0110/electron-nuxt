import {
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
} from '@i18n-core';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import appSchema from '../app/locales/en';
import { difference } from 'es-toolkit/array';
import landingSchema from '../landing/app/locales/en';

interface ILocaleDefinitionLike {code: string;}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectLeafPaths(node: unknown, prefix = ''): string[] {
    if (!isRecord(node)) {
        throw new Error(`Expected object at "${prefix || '<root>'}"`);
    }

    const paths: string[] = [];

    for (const key of Object.keys(node).sort()) {
        const value = node[key];
        const path = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'string') {
            paths.push(path);
            continue;
        }

        if (isRecord(value)) {
            paths.push(...collectLeafPaths(value, path));
            continue;
        }

        throw new Error(`Unexpected value at "${path}"; expected string or object`);
    }

    return paths;
}

function hasStringPath(node: unknown, dottedPath: string): boolean {
    const segments = dottedPath.split('.');
    let current: unknown = node;

    for (const segment of segments) {
        if (!isRecord(current) || !(segment in current)) {
            return false;
        }

        current = current[segment];
    }

    return typeof current === 'string';
}

function diffKeys(expected: Set<string>, actual: Set<string>) {
    const missing = difference(Array.from(expected), Array.from(actual)).sort();
    const extra = difference(Array.from(actual), Array.from(expected)).sort();

    return {
        missing,
        extra,
    };
}

function formatKeyList(keys: string[]): string {
    if (keys.length === 0) {
        return '(none)';
    }

    const limit = 12;
    const visible = keys.slice(0, limit);
    const suffix = keys.length > limit ? ` ... (+${keys.length - limit} more)` : '';

    return `${visible.join(', ')}${suffix}`;
}

function assertParity(
    label: string,
    schema: unknown,
    localeMessages: Record<string, unknown>,
    errors: string[],
) {
    const expectedPaths = new Set(collectLeafPaths(schema));

    for (const [
        locale,
        messages,
    ] of Object.entries(localeMessages)) {
        const actualPaths = new Set(collectLeafPaths(messages));
        const {
            missing,
            extra,
        } = diffKeys(expectedPaths, actualPaths);

        if (missing.length > 0 || extra.length > 0) {
            errors.push(
                `${label} locale "${locale}" mismatch: missing=${formatKeyList(missing)}; extra=${formatKeyList(extra)}`,
            );
        }
    }
}

function assertLocaleMetadataParity(
    label: string,
    localeCodes: readonly string[],
    localeDefinitions: readonly ILocaleDefinitionLike[],
    errors: string[],
) {
    const definitionCodes = localeDefinitions.map((definition) => definition.code);
    const missingDefinitions = difference(Array.from(localeCodes), definitionCodes);
    const extraDefinitions = difference(definitionCodes, Array.from(localeCodes));

    if (missingDefinitions.length > 0 || extraDefinitions.length > 0) {
        errors.push(
            `${label} locale metadata mismatch: missing definitions=${formatKeyList(missingDefinitions)}; extra definitions=${formatKeyList(extraDefinitions)}`,
        );
    }
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

async function loadLocaleMessages(relativeDirectory: string): Promise<Record<string, unknown>> {
    const entries = await Promise.all(LOCALE_CODES.map(async (localeCode) => {
        const localePath = path.join(projectRoot, relativeDirectory, `${localeCode}.ts`);
        const localeModule = await import(pathToFileURL(localePath).href) as {default?: unknown;};
        return [
            localeCode,
            localeModule.default,
        ] as const;
    }));

    return Object.fromEntries(entries);
}

async function main() {
    const errors: string[] = [];
    const [
        appLocaleMessages,
        landingLocaleMessages,
    ] = await Promise.all([
        loadLocaleMessages('app/locales'),
        loadLocaleMessages('landing/app/locales'),
    ]);

    assertLocaleMetadataParity('app', LOCALE_CODES, LOCALE_DEFINITIONS, errors);
    assertLocaleMetadataParity('landing', LOCALE_CODES, LOCALE_DEFINITIONS, errors);

    if (!hasStringPath(appSchema, 'contextMenu.copySelectionToClipboard')) {
        errors.push('App schema is missing required key "contextMenu.copySelectionToClipboard"');
    }

    assertParity('app', appSchema, appLocaleMessages, errors);
    assertParity('landing', landingSchema, landingLocaleMessages, errors);

    if (errors.length > 0) {
        console.error('Locale parity check failed:\n');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log('Locale parity check passed for app and landing locales.');
}

main().catch((error) => {
    console.error('Failed to check locale parity:', error);
    process.exit(1);
});
