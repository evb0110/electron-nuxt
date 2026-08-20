import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    createSourceFile,
    forEachChild,
    isCallExpression,
    isIdentifier,
    isObjectLiteralExpression,
    isPropertyAssignment,
    isStringLiteral,
    ScriptTarget,
} from 'typescript';
import type {
    Expression,
    Node,
    ObjectLiteralExpression,
    PropertyName,
} from 'typescript';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}

function getPropertyNameText(name: PropertyName) {
    if (isIdentifier(name) || isStringLiteral(name)) {
        return name.text;
    }

    return null;
}

function getPropertyInitializer(object: ObjectLiteralExpression, propertyName: string) {
    for (const property of object.properties) {
        if (!isPropertyAssignment(property)) {
            continue;
        }

        if (getPropertyNameText(property.name) === propertyName) {
            return property.initializer;
        }
    }

    return null;
}

function getRequiredObjectProperty(object: ObjectLiteralExpression, propertyName: string) {
    const initializer = getPropertyInitializer(object, propertyName);
    if (!initializer || !isObjectLiteralExpression(initializer)) {
        throw new Error(`Expected object property: ${propertyName}`);
    }

    return initializer;
}

function findNuxtConfigObject(root: Node) {
    let configObject: ObjectLiteralExpression | null = null;

    function visit(node: Node) {
        if (configObject) {
            return;
        }

        if (
            isCallExpression(node)
            && isIdentifier(node.expression)
            && node.expression.text === 'defineNuxtConfig'
        ) {
            const firstArgument: Expression | undefined = node.arguments[0];
            if (firstArgument && isObjectLiteralExpression(firstArgument)) {
                configObject = firstArgument;
            }
            return;
        }

        forEachChild(node, visit);
    }

    visit(root);

    if (!configObject) {
        throw new Error('Expected defineNuxtConfig object literal');
    }

    return configObject;
}

describe('Nuxt config policy', () => {
    it('keeps preference-cookie ownership hardened and explicit', async () => {
        const rootSource = await readProjectFile('nuxt.config.ts');
        const landingSource = await readProjectFile('landing/nuxt.config.ts');

        expect(rootSource).toContain('storage: \'localStorage\'');
        expect(rootSource).not.toContain('storage: \'cookie\'');
        expect(rootSource).toMatch(
            /cookieKey: 'i18n_redirected',[\s\S]*?cookieSecure: process\.env\.NODE_ENV === 'production'/u,
        );
        expect(landingSource).toMatch(
            /cookieKey: 'i18n_locale',[\s\S]*?cookieSecure: process\.env\.NODE_ENV === 'production'/u,
        );
    });

    it('publishes the cookie and browser-storage disclosure in every privacy locale', async () => {
        const rootPrivacy = await readProjectFile('app/pages/privacy.vue');
        const landingPrivacy = await readProjectFile('landing/app/pages/privacy.vue');
        const landingLocalePaths = [
            'de',
            'en',
            'es',
            'fr',
            'it',
            'nl',
            'pt',
            'ptBr',
            'ru',
        ].map(locale => `landing/app/locales/${locale}.ts`);

        expect(rootPrivacy).toContain('Cookies and browser storage');
        expect(rootPrivacy).toContain('opaque, HttpOnly cohort cookie for up to 90 days');
        expect(rootPrivacy).toContain('random per-session analytics identifier');
        expect(rootPrivacy).toContain('does not set advertising or third-party cookies');
        expect(rootPrivacy).toContain('Файлы cookie языка могут храниться до одного года');
        expect(rootPrivacy).toContain('файл cookie темы — до 180 дней');
        expect(rootPrivacy).toContain('файл cookie когорты с атрибутом HttpOnly сроком до 90 дней');
        expect(landingPrivacy).toContain('t(\'privacy.storage.heading\')');
        expect(landingPrivacy).toContain('t(\'privacy.storage.body\')');

        for (const localePath of landingLocalePaths) {
            const localeSource = await readProjectFile(localePath);
            expect(localeSource, localePath).toContain('storage: {');
            expect(localeSource, localePath).toContain('HttpOnly');
            expect(localeSource, localePath).toContain('90');
            expect(localeSource, localePath).toContain('IndexedDB');
        }
    });

    it('keeps Vite browser worker bundles in module-compatible format', async () => {
        const source = await readProjectFile('nuxt.config.ts');
        const sourceFile = createSourceFile('nuxt.config.ts', source, ScriptTarget.Latest, true);
        const configObject = findNuxtConfigObject(sourceFile);
        const viteConfig = getRequiredObjectProperty(configObject, 'vite');
        const workerConfig = getRequiredObjectProperty(viteConfig, 'worker');
        const format = getPropertyInitializer(workerConfig, 'format');

        expect(format && isStringLiteral(format) ? format.text : null).toBe('es');
    });

    it('composes the complete app security policy into every explicit route header rule', async () => {
        const source = await readProjectFile('nuxt.config.ts');
        const routeRulesStart = source.indexOf('    routeRules: {');
        const routeRulesEnd = source.indexOf('\n    sourcemap:', routeRulesStart);
        const routeRules = source.slice(routeRulesStart, routeRulesEnd);

        expect(source).toContain('"default-src \'self\'"');
        expect(source).toContain('"script-src-attr \'none\'"');
        expect(source).toContain('"object-src \'none\'"');
        expect(source).toContain('"frame-ancestors \'none\'"');
        expect(source).toContain('\'Content-Security-Policy\': appContentSecurityPolicy');
        expect(source).toContain('\'Cross-Origin-Opener-Policy\': \'same-origin\'');
        expect(source).toContain('\'Cross-Origin-Resource-Policy\': \'same-origin\'');
        expect(source).toContain('\'X-Frame-Options\': \'DENY\'');
        expect(source).toContain('\'X-Content-Type-Options\': \'nosniff\'');
        expect(source).toContain('\'Referrer-Policy\': \'strict-origin-when-cross-origin\'');
        expect(source).toContain('\'Permissions-Policy\':');
        expect(routeRules).not.toMatch(/headers:\s*\{/u);
        expect(routeRules).toContain('headers: appSecurityHeaders');
        expect(routeRules.match(/headers: withAppSecurityHeaders\(/gu)?.length).toBeGreaterThanOrEqual(10);
    });

    it('composes the complete landing security policy into explicit route rules', async () => {
        const source = await readProjectFile('landing/nuxt.config.ts');
        const routeRulesStart = source.indexOf('    routeRules: {');
        const routeRulesEnd = source.indexOf('\n    sitemap:', routeRulesStart);
        const routeRules = source.slice(routeRulesStart, routeRulesEnd);

        expect(source).toMatch(/default-src \\'self\\'/u);
        expect(source).toMatch(/frame-ancestors \\'none\\'/u);
        expect(source).toMatch(/frame-src \\'none\\'/u);
        expect(source).toContain('\'Content-Security-Policy\': landingContentSecurityPolicy');
        expect(source).toContain('\'Cross-Origin-Opener-Policy\': \'same-origin\'');
        expect(source).toContain('\'Cross-Origin-Resource-Policy\': \'same-origin\'');
        expect(source).toContain('\'X-Frame-Options\': \'DENY\'');
        expect(source).toContain('\'X-Content-Type-Options\': \'nosniff\'');
        expect(source).toContain('\'Referrer-Policy\': \'strict-origin-when-cross-origin\'');
        expect(source).toContain('\'Permissions-Policy\':');
        expect(routeRules).not.toMatch(/headers:\s*\{/u);
        expect(routeRules).toContain('headers: landingSecurityHeaders');
        expect(routeRules.match(/headers: withLandingSecurityHeaders\(/gu)?.length).toBeGreaterThanOrEqual(7);
    });
});
