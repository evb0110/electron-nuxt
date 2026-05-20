import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { parse as parseBabel } from '@babel/parser';

interface ICommonJsPackageRule {
    packageName: string;
    suggestedImport: string;
}

interface IImportViolation {
    filePath: string;
    line: number;
    packageName: string;
    importedNames: string[];
    suggestedImport: string;
}

interface IImportDeclarationLike {
    type: 'ImportDeclaration';
    source: {value: string;};
    specifiers: unknown[];
    loc?: {start: {line: number;};} | null;
}

interface IImportSpecifierLike {
    type: 'ImportSpecifier';
    importKind?: 'type' | 'value' | null;
    imported: {
        type: 'Identifier' | 'StringLiteral';
        name?: string;
        value?: string;
    };
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRECTORIES = [
    'app',
    'electron',
    'packages',
    'server',
    'scripts',
    'tests',
];
const SOURCE_EXTENSIONS = new Set([
    '.js',
    '.jsx',
    '.mjs',
    '.ts',
    '.tsx',
    '.vue',
]);
const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.nuxt',
    '.output',
    '.tmp',
    'coverage',
    'dist',
    'dist-electron',
    'node_modules',
    'nuxt-output',
]);
const COMMONJS_PACKAGE_RULES: ICommonJsPackageRule[] = [{
    packageName: 'utif',
    suggestedImport: 'import UTIF from \'utif\'; const { decode, decodeImage, toRGBA8 } = UTIF;',
}];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isImportDeclaration(value: unknown): value is IImportDeclarationLike {
    return isRecord(value) && value.type === 'ImportDeclaration';
}

function isImportSpecifier(value: unknown): value is IImportSpecifierLike {
    return isRecord(value) && value.type === 'ImportSpecifier';
}

function getVueScriptContent(source: string): string {
    const scriptBlocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];

    return scriptBlocks
        .map((match) => match[1] ?? '')
        .join('\n');
}

function getParseableSource(filePath: string, source: string): string {
    return filePath.endsWith('.vue')
        ? getVueScriptContent(source)
        : source;
}

async function collectSourceFiles(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
            continue;
        }

        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectSourceFiles(entryPath));
            continue;
        }

        if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
            files.push(entryPath);
        }
    }

    return files;
}

function getImportedName(specifier: IImportSpecifierLike): string {
    const imported = specifier.imported;
    if (imported.type === 'Identifier') {
        return imported.name ?? '<unknown>';
    }

    return imported.value ?? '<unknown>';
}

function findCommonJsNamedImportViolations(
    filePath: string,
    source: string,
): IImportViolation[] {
    const parseableSource = getParseableSource(filePath, source);
    if (!parseableSource.trim()) {
        return [];
    }

    const ast = parseBabel(parseableSource, {
        sourceType: 'module',
        plugins: [
            'decorators',
            'importAttributes',
            'jsx',
            'typescript',
        ],
    });
    const violations: IImportViolation[] = [];

    for (const statement of ast.program.body as unknown[]) {
        if (!isImportDeclaration(statement)) {
            continue;
        }

        const rule = COMMONJS_PACKAGE_RULES.find((item) => item.packageName === statement.source.value);
        if (!rule) {
            continue;
        }

        const runtimeNamedImports = statement.specifiers
            .filter(isImportSpecifier)
            .filter((specifier) => specifier.importKind !== 'type')
            .map(getImportedName);

        if (runtimeNamedImports.length === 0) {
            continue;
        }

        violations.push({
            filePath,
            line: statement.loc?.start.line ?? 1,
            packageName: rule.packageName,
            importedNames: runtimeNamedImports,
            suggestedImport: rule.suggestedImport,
        });
    }

    return violations;
}

async function main() {
    const sourceFiles = (await Promise.all(
        SOURCE_DIRECTORIES.map((directory) => collectSourceFiles(path.join(REPO_ROOT, directory))),
    )).flat();
    const violations: IImportViolation[] = [];

    for (const sourceFile of sourceFiles) {
        const source = await readFile(sourceFile, 'utf-8');
        violations.push(...findCommonJsNamedImportViolations(sourceFile, source));
    }

    if (violations.length === 0) {
        console.log('CommonJS import compatibility check passed.');
        return;
    }

    console.error('CommonJS import compatibility check failed.');
    for (const violation of violations) {
        const relativePath = path.relative(REPO_ROOT, violation.filePath);
        console.error(
            `- ${relativePath}:${violation.line} imports runtime named export(s) ${
                violation.importedNames.join(', ')
            } from CommonJS package "${violation.packageName}".`,
        );
        console.error(`  Use: ${violation.suggestedImport}`);
    }
    process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error('Failed to check CommonJS imports:', error);
    process.exitCode = 1;
});
