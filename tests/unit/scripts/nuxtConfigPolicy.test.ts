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
    it('keeps Vite browser worker bundles in module-compatible format', async () => {
        const source = await readProjectFile('nuxt.config.ts');
        const sourceFile = createSourceFile('nuxt.config.ts', source, ScriptTarget.Latest, true);
        const configObject = findNuxtConfigObject(sourceFile);
        const viteConfig = getRequiredObjectProperty(configObject, 'vite');
        const workerConfig = getRequiredObjectProperty(viteConfig, 'worker');
        const format = getPropertyInitializer(workerConfig, 'format');

        expect(format && isStringLiteral(format) ? format.text : null).toBe('es');
    });
});
