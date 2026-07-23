import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const documentWorkspacePath = 'app/modules/workspace-shell/components/DocumentWorkspace.vue';
const deferredWorkspaceSearchPath = 'app/modules/workspace-shell/composables/createDeferredWorkspaceSearch.ts';
const workspaceDocumentDriverPath = 'app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts';

const expectedOrchestrationGroups = new Set([
    'annotationSession',
    'documentDriver',
    'documentControls',
    'exportWorkflow',
    'fileLifecycle',
    'interactionControls',
    'metadata',
    'pageContextMenuControls',
    'printWorkflow',
    'saveWorkflow',
    'viewNavigation',
    'viewerShell',
    'workspaceSettings',
]);

function readWorkspaceFile(path: string) {
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function readScriptSetup(source: string) {
    const match = source.match(/<script\s+setup(?:\s+[^>]*)?>([\s\S]*?)<\/script>/u);
    const scriptSetup = match?.[1];
    if (scriptSetup === undefined) {
        throw new Error('DocumentWorkspace.vue is missing a <script setup> block');
    }
    return scriptSetup;
}

function readPropertyName(name: ts.PropertyName, sourceFile: ts.SourceFile) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return name.getText(sourceFile);
}

function readObjectBindingPropertyNames(pattern: ts.ObjectBindingPattern, sourceFile: ts.SourceFile) {
    return pattern.elements.map((element) => {
        if (element.dotDotDotToken) {
            return '...';
        }
        if (element.propertyName) {
            return readPropertyName(element.propertyName, sourceFile);
        }
        if (ts.isIdentifier(element.name)) {
            return element.name.text;
        }
        return element.name.getText(sourceFile);
    });
}

function isUseWorkspaceOrchestrationCall(expression: ts.Expression) {
    return ts.isCallExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'useWorkspaceOrchestration';
}

describe('DocumentWorkspace orchestration grouping', () => {
    it('consumes useWorkspaceOrchestration through named role groups only', () => {
        const source = readWorkspaceFile(documentWorkspacePath);
        const scriptSetup = readScriptSetup(source);
        const sourceFile = ts.createSourceFile(
            documentWorkspacePath,
            scriptSetup,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const orchestrationIdentifiers = new Set<string>();
        const consumedGroups = new Set<string>();
        const violations = new Set<string>();

        function recordTopLevelBinding(names: string[], origin: string) {
            const restBinding = names.includes('...');
            if (restBinding) {
                violations.add(`${origin} uses a rest binding from useWorkspaceOrchestration`);
            }

            const unexpectedNames = names.filter(name => name !== '...' && !expectedOrchestrationGroups.has(name));
            if (unexpectedNames.length > 0) {
                violations.add(`${origin} reads flat orchestration properties: ${unexpectedNames.join(', ')}`);
            }

            names
                .filter(name => expectedOrchestrationGroups.has(name))
                .forEach(name => consumedGroups.add(name));
        }

        function visit(node: ts.Node) {
            if (ts.isVariableDeclaration(node) && node.initializer) {
                if (ts.isIdentifier(node.name)) {
                    if (isUseWorkspaceOrchestrationCall(node.initializer)) {
                        orchestrationIdentifiers.add(node.name.text);
                    } else if (
                        ts.isIdentifier(node.initializer)
                        && orchestrationIdentifiers.has(node.initializer.text)
                    ) {
                        orchestrationIdentifiers.add(node.name.text);
                    }
                }

                if (
                    ts.isObjectBindingPattern(node.name)
                    && (
                        isUseWorkspaceOrchestrationCall(node.initializer)
                        || (
                            ts.isIdentifier(node.initializer)
                            && orchestrationIdentifiers.has(node.initializer.text)
                        )
                    )
                ) {
                    recordTopLevelBinding(
                        readObjectBindingPropertyNames(node.name, sourceFile),
                        'top-level orchestration destructure',
                    );
                }
            }

            if (ts.isPropertyAccessExpression(node)) {
                if (
                    ts.isIdentifier(node.expression)
                    && orchestrationIdentifiers.has(node.expression.text)
                    && !expectedOrchestrationGroups.has(node.name.text)
                ) {
                    violations.add(`direct orchestration property access reads flat property: ${node.name.text}`);
                }
            }

            if (ts.isObjectLiteralExpression(node)) {
                node.properties.forEach((property) => {
                    if (
                        ts.isSpreadAssignment(property)
                        && ts.isIdentifier(property.expression)
                        && orchestrationIdentifiers.has(property.expression.text)
                    ) {
                        violations.add('object literal spreads useWorkspaceOrchestration back into a flat object');
                    }
                });
            }

            ts.forEachChild(node, visit);
        }

        visit(sourceFile);

        expect([...violations]).toEqual([]);
        expect([...consumedGroups].sort()).toEqual([...expectedOrchestrationGroups].sort());
    });

    it('fences deferred search replay to the document identity that requested it', () => {
        const source = readWorkspaceFile(deferredWorkspaceSearchPath);
        const handlerStart = source.indexOf('const handleSearchWhenDocumentReady = async () => {');
        const handlerEnd = source.indexOf('\n    return {', handlerStart);
        expect(handlerStart).toBeGreaterThanOrEqual(0);
        expect(handlerEnd).toBeGreaterThan(handlerStart);
        const handlerSource = source.slice(handlerStart, handlerEnd);
        const identityCaptureIndex = handlerSource.indexOf('const requestedIdentity = options.readIdentity();');
        const readinessWaitIndex = handlerSource.indexOf('await waitUntilReady()');
        const identityGuardIndex = handlerSource.indexOf('!options.isIdentityCurrent(requestedIdentity)');
        const searchRunIndex = handlerSource.indexOf('await options.handleSearch();');

        expect(identityCaptureIndex).toBeGreaterThanOrEqual(0);
        expect(identityCaptureIndex).toBeLessThan(readinessWaitIndex);
        expect(identityGuardIndex).toBeGreaterThan(readinessWaitIndex);
        expect(identityGuardIndex).toBeLessThan(searchRunIndex);

        const workspaceScript = readScriptSetup(readWorkspaceFile(documentWorkspacePath));
        expect(workspaceScript).toContain('createDeferredWorkspaceSearch({');
        expect(workspaceScript).toContain('documentRevisionToken: documentRevisionToken.value');
        expect(workspaceScript).toContain('workingCopyPath: workingCopyPath.value');
        expect(workspaceScript).toContain('deferredWorkspaceSearch.dispose();');
    });

    it('routes DjVu print through a PDF projection and waits for output-service handoff', () => {
        const source = readWorkspaceFile(workspaceDocumentDriverPath);
        const printStart = source.indexOf('async function prepareDjvuPrint(');
        const printEnd = source.indexOf('\nexport function createWorkspaceDocumentDriverForAdapter(', printStart);
        const printSource = source.slice(printStart, printEnd);
        const projectionIndex = printSource.indexOf('ensurePdfProjection(printSession');
        const reasonIndex = printSource.indexOf('}, \'print\', projectionSignal)');
        const printIndex = printSource.indexOf('printDjvuPath(sourcePath');
        const stateIndex = printSource.indexOf('getJobState(result.jobId ?? jobId)');
        const handoffIndex = printSource.indexOf('onNativePrintHandoffStart?.()');

        expect(printStart).toBeGreaterThanOrEqual(0);
        expect(projectionIndex).toBeGreaterThanOrEqual(0);
        expect(reasonIndex).toBeGreaterThan(projectionIndex);
        expect(printIndex).toBeGreaterThan(projectionIndex);
        expect(stateIndex).toBeGreaterThan(printIndex);
        expect(handoffIndex).toBeGreaterThan(stateIndex);
        expect(printSource).toContain('outputState.status !== \'handoff\' && outputState.status !== \'completed\'');
    });
});
