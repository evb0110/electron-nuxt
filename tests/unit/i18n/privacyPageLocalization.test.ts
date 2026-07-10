import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
interface IMessageTree {readonly [key: string]: string | IMessageTree;}

interface IPrivacyLocale {privacy: IMessageTree & {
    assistant: IMessageTree;
    contact: IMessageTree & {linkLabel: string};
    documents: IMessageTree & {body: string};
    hero: IMessageTree & {title: string};
};}

async function loadLocale(fileName: string) {
    const module = await import(pathToFileURL(resolve(
        process.cwd(),
        `landing/app/locales/${fileName}.ts`,
    )).href) as {default: IPrivacyLocale};
    return module.default;
}

const [
    de,
    en,
    es,
    fr,
    italian,
    nl,
    pt,
    ptBr,
    ru,
] = await Promise.all([
    loadLocale('de'),
    loadLocale('en'),
    loadLocale('es'),
    loadLocale('fr'),
    loadLocale('it'),
    loadLocale('nl'),
    loadLocale('pt'),
    loadLocale('ptBr'),
    loadLocale('ru'),
]);

const locales = {
    de,
    en,
    es,
    fr,
    it: italian,
    nl,
    pt,
    'pt-BR': ptBr,
    ru,
} as const;
const pageSource = readFileSync(resolve(process.cwd(), 'landing/app/pages/privacy.vue'), 'utf8');

function flattenLeafPaths(tree: IMessageTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([
        key,
        value,
    ]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [path] : flattenLeafPaths(value, path);
    });
}

describe('landing privacy localization', () => {
    it('keeps every privacy locale in exact leaf parity with English', () => {
        const expectedPaths = flattenLeafPaths(en.privacy).sort();
        for (const [
            locale,
            messages,
        ] of Object.entries(locales)) {
            expect(flattenLeafPaths(messages.privacy).sort(), locale).toEqual(expectedPaths);
            for (const path of expectedPaths) {
                const value = path.split('.').reduce<string | IMessageTree>(
                    (node, key) => typeof node === 'string' ? node : node[key] ?? '',
                    messages.privacy,
                );
                expect(typeof value === 'string' && value.trim().length > 0, `${locale}:${path}`).toBe(true);
            }
        }
    });

    it('provides localized privacy copy rather than English fallbacks', () => {
        for (const [
            locale,
            messages,
        ] of Object.entries(locales)) {
            if (locale === 'en') {
                continue;
            }
            expect(messages.privacy.hero.title, locale).not.toBe(en.privacy.hero.title);
            expect(messages.privacy.documents.body, locale).not.toBe(en.privacy.documents.body);
            expect(messages.privacy.contact.linkLabel, locale).not.toBe(en.privacy.contact.linkLabel);
        }
    });

    it('renders every privacy leaf through the typed composer and keeps the contact link accessible', () => {
        const renderedKeys = [...pageSource.matchAll(/t\('(privacy\.[^']+)'\)/gu)]
            .map(match => match[1])
            .filter((key): key is string => key !== undefined);
        const expectedKeys = flattenLeafPaths(en.privacy, 'privacy');

        expect([...new Set(renderedKeys)].sort()).toEqual(expectedKeys.sort());
        expect(pageSource).toContain('const { t } = useTypedI18n();');
        expect(pageSource).toContain('href="https://github.com/evb0110/evb-viewer/issues"');
        expect(pageSource).toContain('rel="noreferrer"');
        expect(pageSource).toMatch(/<a[\s\S]*>\{\{ t\('privacy\.contact\.linkLabel'\) \}\}<\/a>/u);
        expect(pageSource).not.toContain('Privacy policy for EVB Viewer desktop');
        expect(pageSource).not.toContain('Documents and local processing');
    });
});
