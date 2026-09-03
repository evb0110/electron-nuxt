import path from 'node:path';
import {ESLint} from 'eslint';
import type {Rule} from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IAstNode {
    [key: string]: unknown;
    type: string;
}

interface ICallExpressionNode {
    arguments: unknown[];
    callee: unknown;
}

function asAstNode(value: unknown): IAstNode | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const node = value as Record<string, unknown>;
    return typeof node.type === 'string' ? node as IAstNode : null;
}

function isLoggerIdentifier(node: IAstNode | null) {
    return node?.type === 'Identifier'
        && typeof node.name === 'string'
        && (
            node.name === 'log'
            || node.name === 'logger'
            || node.name.endsWith('Log')
            || node.name.endsWith('Logger')
        );
}

function isLoggerErrorCall(node: Rule.Node) {
    const call = node as ICallExpressionNode;
    const callee = asAstNode(call.callee);
    if (
        callee?.type !== 'MemberExpression'
        || callee.computed !== false
    ) {
        return false;
    }
    const property = asAstNode(callee.property);
    if (property?.type !== 'Identifier' || property.name !== 'error') {
        return false;
    }
    const object = asAstNode(callee.object);
    if (isLoggerIdentifier(object)) {
        return true;
    }
    if (object?.type !== 'MemberExpression' || object.computed !== false) {
        return false;
    }
    const objectObject = asAstNode(object.object);
    const objectProperty = asAstNode(object.property);
    return objectObject?.type === 'Identifier'
        && objectObject.name === 'options'
        && objectProperty?.type === 'Identifier'
        && objectProperty.name === 'logger';
}

function hasNamedObjectProperty(
    value: unknown,
    name: string,
) {
    const object = asAstNode(value);
    if (object?.type !== 'ObjectExpression' || !Array.isArray(object.properties)) {
        return false;
    }
    return object.properties.some(propertyValue => {
        const property = asAstNode(propertyValue);
        const key = asAstNode(property?.key);
        return property?.type === 'Property'
            && property.computed === false
            && key?.type === 'Identifier'
            && key.name === name;
    });
}

const loggerMigrationRule: Rule.RuleModule = {
    meta: {
        schema: [],
        type: 'problem',
    },
    create(context) {
        return {CallExpression: (node: Rule.Node) => {
            if (!isLoggerErrorCall(node)) {
                return;
            }
            const call = node as ICallExpressionNode;
            const failure = call.arguments[1];
            if (
                failure !== undefined
                && (
                    asAstNode(failure)?.type !== 'ObjectExpression'
                    || hasNamedObjectProperty(failure, 'code')
                        && hasNamedObjectProperty(failure, 'context')
                )
            ) {
                return;
            }
            context.report({
                message: 'Main logger errors must carry a closed diagnostic code and context.',
                node,
            });
        }};
    },
};

function createLoggerMigrationEslint() {
    return new ESLint({
        cwd: process.cwd(),
        overrideConfigFile: true,
        overrideConfig: [{
            files: ['electron/**/*.ts'],
            languageOptions: {
                parser: tsParser,
                parserOptions: {
                    ecmaVersion: 2022,
                    sourceType: 'module',
                },
            },
            plugins: {migration: {rules: {'main-logger': loggerMigrationRule}}},
            rules: {'migration/main-logger': 'error'},
        }],
    });
}

describe('remaining Electron main logger migration', () => {
    it('reports zero unclassified callers across Electron', async () => {
        const eslint = createLoggerMigrationEslint();
        const results = await eslint.lintFiles(['electron/**/*.ts']);
        const messages = results.flatMap(result => result.messages
            .filter(message => message.ruleId === 'migration/main-logger')
            .map(message => ({
                column: message.column,
                file: path.relative(process.cwd(), result.filePath),
                line: message.line,
                message: message.message,
            })));
        console.warn(JSON.stringify({
            count: messages.length,
            entries: messages,
            name: 'electron-main-unclassified-code',
        }));

        expect(messages).toEqual([]);
    }, 30_000);
});
