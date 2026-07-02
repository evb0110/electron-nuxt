import {isRecord} from '@contracts/runtimeGuards';
import {
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
    isPluralMessage,
    type TTranslationLeaf,
} from '@i18n-core';
import {
    difference,
    uniq,
} from 'es-toolkit/array';
import { isEqual } from 'es-toolkit/predicate';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import desktopSchema from '@i18n-app/messages/en';

interface ILocaleDefinitionLike {
    code: string;
    file: string;
}

type TLocaleTarget = 'app' | 'landing' | 'all';


function collectLeafPaths(node: unknown, prefix = ''): string[] {
    if (!isRecord(node)) {
        throw new Error(`Expected object at "${prefix || '<root>'}"`);
    }

    const paths: string[] = [];

    for (const key of Object.keys(node).sort()) {
        const value = node[key];
        const dottedPath = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'string' || isPluralMessage(value)) {
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

function getLeafPath(node: unknown, dottedPath: string): TTranslationLeaf | null {
    const segments = dottedPath.split('.');
    let current: unknown = node;

    for (const segment of segments) {
        if (!isRecord(current) || !(segment in current)) {
            return null;
        }

        current = current[segment];
    }

    return typeof current === 'string' || isPluralMessage(current)
        ? current
        : null;
}

function hasLeafPath(node: unknown, dottedPath: string) {
    return getLeafPath(node, dottedPath) !== null;
}

function extractPlaceholders(text: string): string[] {
    const placeholders: string[] = [];

    for (const match of text.matchAll(/\{([^}]+)\}/g)) {
        const placeholder = match[1]?.split(',')[0]?.trim();
        if (placeholder) {
            placeholders.push(placeholder);
        }
    }

    return uniq(placeholders).sort();
}

function extractPlaceholdersFromLeaf(leaf: TTranslationLeaf): string[] {
    const texts = typeof leaf === 'string'
        ? [leaf]
        : Object.values(leaf.forms).flatMap(text => typeof text === 'string' ? [text] : []);

    return uniq(texts.flatMap(text => extractPlaceholders(text))).sort();
}

function diffKeys(expected: Set<string>, actual: Set<string>) {
    const missing = difference(Array.from(expected), Array.from(actual)).sort();
    const extra = difference(Array.from(actual), Array.from(expected)).sort();

    return {
        missing,
        extra,
    };
}

function formatKeyList(keys: string[]) {
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
            const expectedMessage = getLeafPath(schema, dottedPath);
            const actualMessage = getLeafPath(messages, dottedPath);

            if (expectedMessage === null || actualMessage === null) {
                continue;
            }

            const expectedPlaceholders = extractPlaceholdersFromLeaf(expectedMessage);
            const actualPlaceholders = extractPlaceholdersFromLeaf(actualMessage);

            if (!isEqual(expectedPlaceholders, actualPlaceholders)) {
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
    const entries = await Promise.all(LOCALE_DEFINITIONS.map(async (localeDefinition) => {
        const localePath = path.join(projectRoot, relativeDirectory, localeDefinition.file);
        const localeModule = await import(pathToFileURL(localePath).href) as {default?: unknown;};
        return [
            localeDefinition.code,
            localeModule.default,
        ] as const;
    }));

    return Object.fromEntries(entries);
}

async function loadDefaultExport(relativePath: string) {
    const absolutePath = path.join(projectRoot, relativePath);
    const module = await import(pathToFileURL(absolutePath).href) as {default?: unknown;};
    return module.default;
}

function listLocaleFileNames(relativeDirectory: string): string[] {
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    return readdirSync(absoluteDirectory)
        .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
        .sort();
}

function assertRuntimeLocaleParity(errors: string[]) {
    const messagesDir = 'packages/i18n-app/messages';
    const runtimeDir = 'app/i18n/runtime-locales';
    const messagesFiles = new Set(listLocaleFileNames(messagesDir));
    const runtimeFiles = new Set(listLocaleFileNames(runtimeDir));

    const missingRuntime = difference(Array.from(messagesFiles), Array.from(runtimeFiles)).sort();
    const missingMessages = difference(Array.from(runtimeFiles), Array.from(messagesFiles)).sort();

    for (const fileName of missingRuntime) {
        errors.push(
            `Runtime locale stub missing: expected ${runtimeDir}/${fileName} to mirror ${messagesDir}/${fileName}`,
        );
    }

    for (const fileName of missingMessages) {
        errors.push(
            `Locale messages file missing: expected ${messagesDir}/${fileName} to mirror ${runtimeDir}/${fileName}`,
        );
    }
}

function parseTarget(argv = process.argv.slice(2)): TLocaleTarget {
    const targetArg = argv.find(argument => argument.startsWith('--target='));
    const target = targetArg?.slice('--target='.length) ?? 'all';

    if (target === 'app' || target === 'landing' || target === 'all') {
        return target;
    }

    throw new Error(`Expected --target to be one of: app, landing, all. Received "${target}".`);
}

function formatTarget(target: TLocaleTarget) {
    if (target === 'app') {
        return 'desktop package locales';
    }
    if (target === 'landing') {
        return 'landing locales';
    }
    return 'desktop package locales and landing locales';
}

async function main() {
    const target = parseTarget();
    const errors: string[] = [];

    if (target === 'app' || target === 'all') {
        assertRuntimeLocaleParity(errors);
        const desktopLocaleMessages = await loadLocaleMessages('packages/i18n-app/messages');

        assertLocaleMetadataParity('desktop', LOCALE_CODES, LOCALE_DEFINITIONS, errors);

        if (!hasLeafPath(desktopSchema, 'contextMenu.copySelectionToClipboard')) {
            errors.push('Desktop schema is missing required key "contextMenu.copySelectionToClipboard"');
        }

        assertParity('desktop', desktopSchema, desktopLocaleMessages, errors);
        assertPlaceholderParity('desktop', desktopSchema, desktopLocaleMessages, errors);
    }

    if (target === 'landing' || target === 'all') {
        const [
            landingSchema,
            landingLocaleMessages,
        ] = await Promise.all([
            loadDefaultExport('landing/app/locales/en.ts'),
            loadLocaleMessages('landing/app/locales'),
        ]);

        assertLocaleMetadataParity('landing', LOCALE_CODES, LOCALE_DEFINITIONS, errors);
        assertParity('landing', landingSchema, landingLocaleMessages, errors);
        assertPlaceholderParity('landing', landingSchema, landingLocaleMessages, errors);
    }

    if (errors.length > 0) {
        console.error('Locale parity check failed:\n');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log(`Locale parity check passed for ${formatTarget(target)}.`);
}

main().catch((error) => {
    console.error('Failed to check locale parity:', error);
    process.exit(1);
});
