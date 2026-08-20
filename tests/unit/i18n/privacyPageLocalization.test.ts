import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createSourceFile,
    forEachChild,
    isAsExpression,
    isIdentifier,
    isObjectLiteralExpression,
    isPropertyAssignment,
    isStringLiteral,
    isVariableDeclaration,
    ScriptTarget,
} from 'typescript';
import type {
    Expression,
    Node,
    ObjectLiteralExpression,
} from 'typescript';
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
const rootPageSource = readFileSync(resolve(process.cwd(), 'app/pages/privacy.vue'), 'utf8');

function flattenLeafPaths(tree: IMessageTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([
        key,
        value,
    ]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [path] : flattenLeafPaths(value, path);
    });
}

function unwrapConstAssertion(expression: Expression): Expression {
    return isAsExpression(expression) ? unwrapConstAssertion(expression.expression) : expression;
}

function readMessageTree(object: ObjectLiteralExpression): IMessageTree {
    return Object.fromEntries(object.properties.map(property => {
        if (!isPropertyAssignment(property)) {
            throw new Error('Privacy copy may contain only property assignments');
        }
        const propertyName = property.name.getText().replace(/^['"]|['"]$/gu, '');
        const value = unwrapConstAssertion(property.initializer);
        if (isStringLiteral(value)) {
            return [
                propertyName,
                value.text,
            ];
        }
        if (isObjectLiteralExpression(value)) {
            return [
                propertyName,
                readMessageTree(value),
            ];
        }
        throw new Error(`Unsupported privacy copy value for ${propertyName}`);
    }));
}

function loadRootPrivacyCopy(): {
    en: IMessageTree;
    ru: IMessageTree;
} {
    const script = rootPageSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)?.[1];
    if (!script) {
        throw new Error('Root privacy page script was not found');
    }

    const sourceFile = createSourceFile('privacy.vue.ts', script, ScriptTarget.Latest, true);
    let privacyCopyObject: ObjectLiteralExpression | null = null;
    const visit = (node: Node) => {
        if (
            isVariableDeclaration(node)
            && isIdentifier(node.name)
            && node.name.text === 'PRIVACY_COPY'
            && node.initializer
        ) {
            const initializer = unwrapConstAssertion(node.initializer);
            if (isObjectLiteralExpression(initializer)) {
                privacyCopyObject = initializer;
            }
        }
        forEachChild(node, visit);
    };
    visit(sourceFile);

    if (!privacyCopyObject) {
        throw new Error('PRIVACY_COPY object was not found');
    }
    const messages = readMessageTree(privacyCopyObject);
    const en = messages.en;
    const ru = messages.ru;
    if (typeof en === 'string' || typeof ru === 'string' || !en || !ru) {
        throw new Error('PRIVACY_COPY must define English and Russian message trees');
    }
    return {
        en,
        ru,
    };
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

describe('root privacy localization', () => {
    it('keeps the complete Russian policy structurally aligned with English', () => {
        const rootPrivacy = loadRootPrivacyCopy();
        const expectedPaths = flattenLeafPaths(rootPrivacy.en).sort();

        expect(flattenLeafPaths(rootPrivacy.ru).sort()).toEqual(expectedPaths);
        for (const path of expectedPaths) {
            const russianValue = path.split('.').reduce<string | IMessageTree>(
                (node, key) => typeof node === 'string' ? node : node[key] ?? '',
                rootPrivacy.ru,
            );
            expect(typeof russianValue === 'string' && russianValue.trim().length > 0, path).toBe(true);
        }
    });

    it('localizes storage, analytics retention, assistant reporting, and metadata in Russian', () => {
        const rootPrivacy = loadRootPrivacyCopy();

        expect(rootPrivacy.ru).not.toEqual(rootPrivacy.en);
        expect(rootPageSource).toContain('locale.value === \'ru\' ? \'ru\' : \'en\'');
        expect(rootPageSource).toContain('useHead(() => ({');
        expect(rootPageSource).toContain('Файлы cookie языка могут храниться до одного года');
        expect(rootPageSource).toContain('файл cookie темы — до 180 дней');
        expect(rootPageSource).toContain('файл cookie когорты с атрибутом HttpOnly сроком до 90 дней');
        expect(rootPageSource).toContain('случайного идентификатора аналитической сессии');
        expect(rootPageSource).toContain('автоматическому удалению через 90 дней');
        expect(rootPageSource).toContain('не копирует и не отправляет ответ');
        expect(rootPageSource).toContain('Политика конфиденциальности | EVB Viewer');
    });
});
