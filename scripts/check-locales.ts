import { LOCALE_CODES as appLocaleCodes } from '../app/i18n/locale-codes';
import { LOCALE_DEFINITIONS as appLocaleDefinitions } from '../app/i18n/locale-definitions';
import { LOCALE_MESSAGES as appLocaleMessages } from '../app/i18n/locales';
import { EN_MESSAGE_SCHEMA as appSchema } from '../app/i18n/message-schema';
import { LOCALE_CODES as landingLocaleCodes } from '../landing/app/i18n/locale-codes';
import {
    LOCALE_DEFINITIONS as landingLocaleDefinitions,
    LOCALE_MESSAGES as landingLocaleMessages,
} from '../landing/app/i18n/locales';
import { EN_MESSAGE_SCHEMA as landingSchema } from '../landing/app/i18n/message-schema';

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
    const missing = Array.from(expected).filter((key) => !actual.has(key)).sort();
    const extra = Array.from(actual).filter((key) => !expected.has(key)).sort();

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
    const missingDefinitions = localeCodes.filter((code) => !definitionCodes.includes(code));
    const extraDefinitions = definitionCodes.filter((code) => !localeCodes.includes(code));

    if (missingDefinitions.length > 0 || extraDefinitions.length > 0) {
        errors.push(
            `${label} locale metadata mismatch: missing definitions=${formatKeyList(missingDefinitions)}; extra definitions=${formatKeyList(extraDefinitions)}`,
        );
    }
}

const errors: string[] = [];

assertLocaleMetadataParity('app', appLocaleCodes, appLocaleDefinitions, errors);
assertLocaleMetadataParity('landing', landingLocaleCodes, landingLocaleDefinitions, errors);

if (!hasStringPath(appSchema, 'contextMenu.copySelectionToClipboard')) {
    errors.push('App schema is missing required key "contextMenu.copySelectionToClipboard"');
}

assertParity('app', appSchema, appLocaleMessages as Record<string, unknown>, errors);
assertParity('landing', landingSchema, landingLocaleMessages as Record<string, unknown>, errors);

if (errors.length > 0) {
    console.error('Locale parity check failed:\n');
    for (const error of errors) {
        console.error(`- ${error}`);
    }
    process.exit(1);
}

console.log('Locale parity check passed for app and landing locales.');
