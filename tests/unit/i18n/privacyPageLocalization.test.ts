import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { LOCALE_CODES } from '@i18n-core/localeCodes';
import { PRIVACY_MESSAGES } from '@i18n-core';

const projectRoot = process.cwd();
const landingLocaleDirectory = resolve(projectRoot, 'landing/app/locales');
const landingPrivacyPageSource = readFileSync(
    resolve(projectRoot, 'landing/app/pages/privacy.vue'),
    'utf8',
);
const rootPrivacyPageSource = readFileSync(
    resolve(projectRoot, 'app/pages/privacy.vue'),
    'utf8',
);

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected a privacy message object');
    }

    return value as Record<string, unknown>;
}

function flattenLeafPaths(tree: unknown, prefix = ''): string[] {
    return Object.entries(asRecord(tree)).flatMap(([
        key,
        value,
    ]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [path] : flattenLeafPaths(value, path);
    });
}

function getLeaf(tree: unknown, dottedPath: string): unknown {
    return dottedPath.split('.').reduce<unknown>((value, key) => {
        if (typeof value !== 'object' || value === null || !(key in value)) {
            return undefined;
        }

        return (value as Record<string, unknown>)[key];
    }, tree);
}

function localeFileName(locale: typeof LOCALE_CODES[number]): string {
    return locale === 'pt-BR' ? 'ptBr.ts' : `${locale}.ts`;
}

describe('privacy localization', () => {
    it('keeps one typed privacy tree in exact nine-locale leaf parity', () => {
        const expectedPaths = flattenLeafPaths(PRIVACY_MESSAGES.en).sort();

        expect(Object.keys(PRIVACY_MESSAGES).sort()).toEqual([...LOCALE_CODES].sort());

        for (const locale of LOCALE_CODES) {
            const messages = PRIVACY_MESSAGES[locale];

            expect(flattenLeafPaths(messages).sort(), locale).toEqual(expectedPaths);

            for (const path of expectedPaths) {
                const value = getLeaf(messages, path);

                expect(typeof value === 'string' && value.trim().length > 0, `${locale}:${path}`).toBe(true);
            }
        }
    });

    it('keeps translated privacy copy for every non-English locale', () => {
        for (const locale of LOCALE_CODES) {
            if (locale === 'en') {
                continue;
            }

            const messages = PRIVACY_MESSAGES[locale];

            expect(messages.hero.title, locale).not.toBe(PRIVACY_MESSAGES.en.hero.title);
            expect(messages.documents.body, locale).not.toBe(PRIVACY_MESSAGES.en.documents.body);
            expect(messages.contact.linkLabel, locale).not.toBe(PRIVACY_MESSAGES.en.contact.linkLabel);
        }
    });

    it('keeps both privacy pages on the shared tree without inline or Sentry-specific copy', () => {
        expect(rootPrivacyPageSource).toContain('import { PRIVACY_MESSAGES } from \'@i18n-core\';');
        expect(rootPrivacyPageSource).toContain('PRIVACY_MESSAGES[locale.value]');
        expect(rootPrivacyPageSource).not.toContain('PRIVACY_COPY');

        expect(landingPrivacyPageSource).toContain('import { PRIVACY_MESSAGES } from \'@i18n-core\';');
        expect(landingPrivacyPageSource).toContain('PRIVACY_MESSAGES[locale.value]');
        expect(landingPrivacyPageSource).not.toMatch(/t\('privacy\./u);

        expect(JSON.stringify(PRIVACY_MESSAGES)).not.toMatch(/Sentry/iu);
    });

    it('keeps locale modules as thin consumers of the shared privacy tree', () => {
        for (const locale of LOCALE_CODES) {
            const source = readFileSync(
                resolve(landingLocaleDirectory, localeFileName(locale)),
                'utf8',
            );

            expect(source).toContain('import { PRIVACY_MESSAGES } from \'@i18n-core\';');
            expect(source).toMatch(/privacy: PRIVACY_MESSAGES\[/u);
            expect(source).not.toContain('\n    privacy: {');
        }
    });
});
