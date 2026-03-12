import {
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
} from '@i18n-core';
import { difference } from 'es-toolkit/array';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import desktopSchema from '../packages/i18n-app/messages/en';
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
        const dottedPath = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'string') {
            paths.push(dottedPath);
            continue;
        }

        if (isRecord(value)) {
            paths.push(...collectLeafPaths(value, dottedPath));
            continue;
        }

        throw new Error(`Unexpected value at "${dottedPath}"; expected string or object`);
    }

    return paths;
}

function getStringPath(node: unknown, dottedPath: string): string | null {
    const segments = dottedPath.split('.');
    let current: unknown = node;

    for (const segment of segments) {
        if (!isRecord(current) || !(segment in current)) {
            return null;
        }

        current = current[segment];
    }

    return typeof current === 'string' ? current : null;
}

function hasStringPath(node: unknown, dottedPath: string): boolean {
    return getStringPath(node, dottedPath) !== null;
}

function extractPlaceholders(text: string): string[] {
    const placeholders = new Set<string>();

    for (const match of text.matchAll(/\{([^}]+)\}/g)) {
        const placeholder = match[1]?.split(',')[0]?.trim();
        if (placeholder) {
            placeholders.add(placeholder);
        }
    }

    return Array.from(placeholders).sort();
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

function assertPlaceholderParity(
    label: string,
    schema: unknown,
    localeMessages: Record<string, unknown>,
    errors: string[],
) {
    const expectedPaths = collectLeafPaths(schema);

    for (const [
        locale,
        messages,
    ] of Object.entries(localeMessages)) {
        for (const dottedPath of expectedPaths) {
            const expectedMessage = getStringPath(schema, dottedPath);
            const actualMessage = getStringPath(messages, dottedPath);

            if (expectedMessage === null || actualMessage === null) {
                continue;
            }

            const expectedPlaceholders = extractPlaceholders(expectedMessage);
            const actualPlaceholders = extractPlaceholders(actualMessage);

            if (expectedPlaceholders.join('|') !== actualPlaceholders.join('|')) {
                errors.push(
                    `${label} locale "${locale}" placeholder mismatch at "${dottedPath}": expected=${formatKeyList(expectedPlaceholders)}; actual=${formatKeyList(actualPlaceholders)}`,
                );
            }
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
        desktopLocaleMessages,
        landingLocaleMessages,
    ] = await Promise.all([
        loadLocaleMessages('packages/i18n-app/messages'),
        loadLocaleMessages('landing/app/locales'),
    ]);

    assertLocaleMetadataParity('desktop', LOCALE_CODES, LOCALE_DEFINITIONS, errors);
    assertLocaleMetadataParity('landing', LOCALE_CODES, LOCALE_DEFINITIONS, errors);

    if (!hasStringPath(desktopSchema, 'contextMenu.copySelectionToClipboard')) {
        errors.push('Desktop schema is missing required key "contextMenu.copySelectionToClipboard"');
    }

    assertParity('desktop', desktopSchema, desktopLocaleMessages, errors);
    assertPlaceholderParity('desktop', desktopSchema, desktopLocaleMessages, errors);
    assertParity('landing', landingSchema, landingLocaleMessages, errors);

    if (errors.length > 0) {
        console.error('Locale parity check failed:\n');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log('Locale parity check passed for desktop package locales and landing locales.');
}

main().catch((error) => {
    console.error('Failed to check locale parity:', error);
    process.exit(1);
});
