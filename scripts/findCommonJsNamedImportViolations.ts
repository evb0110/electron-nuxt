import path from 'node:path';
import ts from 'typescript';

interface ICommonJsPackageRule {
    packageName: string;
    suggestedImport: string;
}

export interface ICommonJsImportViolation {
    filePath: string;
    line: number;
    packageName: string;
    importedNames: string[];
    suggestedImport: string;
}

type TSourceFileWithParseDiagnostics = ts.SourceFile & { readonly parseDiagnostics: readonly ts.DiagnosticWithLocation[]; };

const COMMONJS_PACKAGE_RULES: ICommonJsPackageRule[] = [{
    packageName: 'utif',
    suggestedImport: 'import UTIF from \'utif\'; const { decode, decodeImage, toRGBA8 } = UTIF;',
}];

function getVueScriptContent(source: string) {
    const scriptBlocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];

    return scriptBlocks
        .map((match) => match[1] ?? '')
        .join('\n');
}

function getParseableSource(filePath: string, source: string) {
    return filePath.endsWith('.vue')
        ? getVueScriptContent(source)
        : source;
}

function getCandidateScriptKinds(filePath: string): ts.ScriptKind[] {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.tsx') {
        return [ts.ScriptKind.TSX];
    }

    if (extension === '.jsx') {
        return [ts.ScriptKind.JSX];
    }

    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
        return [
            ts.ScriptKind.JS,
            ts.ScriptKind.JSX,
        ];
    }

    if (extension === '.vue') {
        return [
            ts.ScriptKind.TS,
            ts.ScriptKind.TSX,
            ts.ScriptKind.JS,
            ts.ScriptKind.JSX,
        ];
    }

    return [ts.ScriptKind.TS];
}

function getParseDiagnostics(sourceFile: ts.SourceFile) {
    return (sourceFile as TSourceFileWithParseDiagnostics).parseDiagnostics;
}

function formatParseDiagnostic(sourceFile: ts.SourceFile, diagnostic: ts.DiagnosticWithLocation) {
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
}

function parseTypeScriptSourceFile(filePath: string, source: string) {
    let fallbackSourceFile: ts.SourceFile | null = null;

    for (const scriptKind of getCandidateScriptKinds(filePath)) {
        const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
        const firstDiagnostic = getParseDiagnostics(sourceFile)[0];
        if (!firstDiagnostic) {
            return sourceFile;
        }
        fallbackSourceFile ??= sourceFile;
    }

    const firstDiagnostic = fallbackSourceFile
        ? getParseDiagnostics(fallbackSourceFile)[0]
        : null;
    if (!fallbackSourceFile || !firstDiagnostic) {
        throw new Error(`Failed to parse ${filePath}.`);
    }

    throw new Error(formatParseDiagnostic(fallbackSourceFile, firstDiagnostic));
}

function getModuleExportNameText(name: ts.ModuleExportName) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        return name.text;
    }

    return '<unknown>';
}

function getNamedRuntimeImports(importDeclaration: ts.ImportDeclaration) {
    const importClause = importDeclaration.importClause;
    if (!importClause || importClause.isTypeOnly || !importClause.namedBindings || !ts.isNamedImports(importClause.namedBindings)) {
        return [];
    }

    return importClause.namedBindings.elements
        .filter(specifier => !specifier.isTypeOnly)
        .map(specifier => specifier.propertyName
            ? getModuleExportNameText(specifier.propertyName)
            : specifier.name.text);
}

export function findCommonJsNamedImportViolations(
    filePath: string,
    source: string,
): ICommonJsImportViolation[] {
    const parseableSource = getParseableSource(filePath, source);
    if (!parseableSource.trim()) {
        return [];
    }

    const sourceFile = parseTypeScriptSourceFile(filePath, parseableSource);
    const violations: ICommonJsImportViolation[] = [];

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }

        const packageName = statement.moduleSpecifier.text;
        const rule = COMMONJS_PACKAGE_RULES.find((item) => item.packageName === packageName);
        if (!rule) {
            continue;
        }

        const runtimeNamedImports = getNamedRuntimeImports(statement);

        if (runtimeNamedImports.length === 0) {
            continue;
        }

        violations.push({
            filePath,
            line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
            packageName: rule.packageName,
            importedNames: runtimeNamedImports,
            suggestedImport: rule.suggestedImport,
        });
    }

    return violations;
}
