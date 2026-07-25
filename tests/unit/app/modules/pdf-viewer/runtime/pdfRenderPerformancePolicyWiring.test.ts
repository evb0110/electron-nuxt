import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    createSourceFile,
    forEachChild,
    isCallExpression,
    isIdentifier,
    isObjectLiteralExpression,
    isPropertyAssignment,
    isShorthandPropertyAssignment,
    ScriptKind,
    ScriptTarget,
} from 'typescript';
import type {
    CallExpression,
    Node,
    SourceFile,
} from 'typescript';
import {
    describe,
    expect,
    it,
} from 'vitest';

const featureControllerPath = 'app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts';
const viewportSessionPath = 'app/modules/pdf-viewer/runtime/sessions/pdfViewportSession.ts';
const renderingSessionPath = 'app/modules/pdf-viewer/runtime/sessions/pdfRenderingSession.ts';

function readProjectSource(path: string) {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    return createSourceFile(path, source, ScriptTarget.Latest, true, ScriptKind.TS);
}

function findCalls(sourceFile: SourceFile, functionName: string) {
    const calls: CallExpression[] = [];

    function visit(node: Node) {
        if (
            isCallExpression(node)
            && isIdentifier(node.expression)
            && node.expression.text === functionName
        ) {
            calls.push(node);
        }
        forEachChild(node, visit);
    }

    visit(sourceFile);
    return calls;
}

function getOnlyCall(sourceFile: SourceFile, functionName: string) {
    const calls = findCalls(sourceFile, functionName);
    if (calls.length !== 1 || !calls[0]) {
        throw new Error(`Expected exactly one ${functionName} call`);
    }
    return calls[0];
}

function getCallArgumentText(sourceFile: SourceFile, functionName: string) {
    const argument = getOnlyCall(sourceFile, functionName).arguments[0];
    if (!argument) {
        throw new Error(`Expected ${functionName} to receive an argument`);
    }
    return argument.getText(sourceFile);
}

function getCallPropertyText(
    sourceFile: SourceFile,
    functionName: string,
    propertyName: string,
) {
    const argument = getOnlyCall(sourceFile, functionName).arguments[0];
    if (!argument || !isObjectLiteralExpression(argument)) {
        throw new Error(`Expected ${functionName} to receive an object`);
    }

    for (const property of argument.properties) {
        if (
            isShorthandPropertyAssignment(property)
            && property.name.text === propertyName
        ) {
            return property.name.text;
        }
        if (
            isPropertyAssignment(property)
            && isIdentifier(property.name)
            && property.name.text === propertyName
        ) {
            return property.initializer.getText(sourceFile);
        }
    }

    throw new Error(`Expected ${functionName} to receive ${propertyName}`);
}

describe('PDF render performance policy wiring', () => {
    it('resolves once and passes the same policy through every section-1 seam', () => {
        const featureController = readProjectSource(featureControllerPath);
        const viewportSession = readProjectSource(viewportSessionPath);
        const renderingSession = readProjectSource(renderingSessionPath);

        expect(findCalls(featureController, 'getPerformanceProfile')).toHaveLength(1);
        expect(getCallArgumentText(featureController, 'resolvePdfRenderPerformancePolicy')).toBe('performanceProfile');
        expect(getCallArgumentText(featureController, 'usePdfViewerOutputScale')).toBe('performancePolicy');
        expect(getCallPropertyText(featureController, 'createPdfViewportSession', 'performancePolicy')).toBe('performancePolicy');
        expect(getCallPropertyText(featureController, 'createPdfRenderingSession', 'performancePolicy')).toBe('performancePolicy');
        expect(getCallPropertyText(viewportSession, 'usePdfViewportViewModel', 'performancePolicy')).toBe('options.performancePolicy');
        expect(getCallPropertyText(renderingSession, 'usePdfViewerZoomRerenderQueue', 'performancePolicy')).toBe('options.performancePolicy');
    });
});
