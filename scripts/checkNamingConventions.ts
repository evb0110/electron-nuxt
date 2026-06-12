import {
    readdir,
    readFile,
} from 'node:fs/promises';
import {
    extname,
    join,
    relative,
    sep,
} from 'node:path';
import ts from 'typescript';

interface INamingIssue {
    path: string;
    expected: string;
}

type TExportSymbolKind = 'class' | 'const' | 'enum' | 'function' | 'interface' | 'let' | 'type' | 'var';

interface IExportSymbol {
    name: string;
    kind: TExportSymbolKind;
    isValue: boolean;
}

const ROOTS = [
    'app',
    'electron',
    'landing',
    'packages',
    'scripts',
    'server',
    'tests',
];

const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.github',
    '.nuxt',
    '.output',
    '.pnpm-store',
    '.vercel',
    '.devkit',
    '.tmp',
    'coverage',
    'dist',
    'dist-electron',
    'node_modules',
    'nuxt-output',
]);

const ROUTE_DIRECTORY_NAMES = new Set([
    'layouts',
    'middleware',
    'pages',
    'routes',
]);

const LOWER_KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CAMEL_RE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const TYPESCRIPT_FILE_EXTENSIONS = new Set([
    '.cts',
    '.mts',
    '.ts',
    '.tsx',
]);
const TEST_DOT_SUFFIXES = new Set([
    'e2e',
    'test',
]);
const APPROVED_DOT_SUFFIXES = new Set([
    'client',
    'config',
    'constants',
    'd',
    'e2e',
    'get',
    'modelPrep',
    'post',
    'service',
    'test',
    'ts',
    'txt',
    'types',
    'worker',
    'xml',
]);
const IGNORED_MAIN_EXPORT_BASE_NAMES = new Set([
    'contract',
    'contracts',
    'eslint.config',
    'index',
    'nuxt.config',
    'playwright.config',
    'public',
    'tailwind.config',
    'vitest.config',
]);

const isLowerKebab = (value: string) => LOWER_KEBAB_RE.test(value);

const isCamel = (value: string) => CAMEL_RE.test(value);

const isPascal = (value: string) => PASCAL_RE.test(value);

const splitPath = (path: string) => path.split(sep);

const isInsideRouteDirectory = (path: string) => splitPath(path).some((part) => ROUTE_DIRECTORY_NAMES.has(part));

const stripKnownTypeScriptSuffixes = (fileName: string) => {
    let stem = fileName;

    if (stem.endsWith('.d.ts')) {
        stem = stem.slice(0, -'.d.ts'.length);
    } else if (stem.endsWith('.cts')) {
        stem = stem.slice(0, -'.cts'.length);
    } else if (stem.endsWith('.mts')) {
        stem = stem.slice(0, -'.mts'.length);
    } else if (stem.endsWith('.tsx')) {
        stem = stem.slice(0, -'.tsx'.length);
    } else if (stem.endsWith('.ts')) {
        stem = stem.slice(0, -'.ts'.length);
    }

    const parts = stem.split('.');

    while (parts.length > 1 && APPROVED_DOT_SUFFIXES.has(parts.at(-1) ?? '')) {
        parts.pop();
    }

    return parts.join('.');
};

const isValidTypeScriptFileName = (fileName: string) => {
    const stem = stripKnownTypeScriptSuffixes(fileName);

    return isCamel(stem);
};

const isTypeScriptFileName = (fileName: string) => TYPESCRIPT_FILE_EXTENSIONS.has(extname(fileName));

const isValidVueFileName = (relativePath: string, fileName: string) => {
    const stem = fileName.slice(0, -'.vue'.length);

    if (fileName === 'app.vue' || fileName === 'error.vue') {
        return true;
    }

    if (isInsideRouteDirectory(relativePath)) {
        return isLowerKebab(stem) || isCamel(stem);
    }

    return isPascal(stem);
};

const normalizeAcronyms = (value: string) => value.replace(
    /[A-Z]+(?=[A-Z][a-z]|$)/g,
    word => word[0] + word.slice(1).toLowerCase(),
);

const lowerFirst = (value: string) => value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);

const snakeToCamel = (value: string) => value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const normalizeExportName = (symbol: IExportSymbol) => {
    let name = symbol.name;

    if ((symbol.kind === 'interface' || symbol.kind === 'type') && /^[IT][A-Z]/.test(name)) {
        name = name.slice(1);
    }

    if (/^[A-Z0-9_]+$/.test(name) && name.includes('_')) {
        return snakeToCamel(name);
    }

    return lowerFirst(normalizeAcronyms(name));
};

const hasExportModifier = (node: ts.Node) => ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));

const isDefaultExport = (node: ts.Node) => ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));

const isValueExportKind = (kind: TExportSymbolKind) => kind === 'class'
    || kind === 'const'
    || kind === 'enum'
    || kind === 'function'
    || kind === 'let'
    || kind === 'var';

const collectExportedSymbols = (sourceFile: ts.SourceFile) => {
    const symbols: IExportSymbol[] = [];
    const add = (name: string, kind: TExportSymbolKind) => symbols.push({
        name,
        kind,
        isValue: isValueExportKind(kind),
    });

    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name && !isDefaultExport(statement)) {
            add(statement.name.text, 'function');
        } else if (ts.isClassDeclaration(statement) && hasExportModifier(statement) && statement.name && !isDefaultExport(statement)) {
            add(statement.name.text, 'class');
        } else if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement)) {
            add(statement.name.text, 'interface');
        } else if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
            add(statement.name.text, 'type');
        } else if (ts.isEnumDeclaration(statement) && hasExportModifier(statement)) {
            add(statement.name.text, 'enum');
        } else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
            const declarationKind: TExportSymbolKind = statement.declarationList.flags & ts.NodeFlags.Const
                ? 'const'
                : statement.declarationList.flags & ts.NodeFlags.Let
                    ? 'let'
                    : 'var';

            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    add(declaration.name.text, declarationKind);
                }
            }
        }
    }

    return symbols;
};

const isInsideIgnoredMainExportArea = (relativePath: string) => relativePath.includes('/types/')
    || relativePath.includes('packages/contracts/');

const getMainExportSymbol = (relativePath: string, sourceFile: ts.SourceFile) => {
    const symbols = collectExportedSymbols(sourceFile);
    const values = symbols.filter(symbol => symbol.isValue);
    const types = symbols.filter(symbol => !symbol.isValue);

    if (symbols.length === 1) {
        return symbols[0];
    }

    if (values.length === 1 && types.length <= 2 && !isInsideIgnoredMainExportArea(relativePath)) {
        return values[0];
    }

    return null;
};

const getExpectedMainExportFileName = (fileName: string, expectedStem: string) => {
    let stem = fileName;

    for (const extension of [
        '.d.ts',
        '.cts',
        '.mts',
        '.tsx',
        '.ts',
    ]) {
        if (stem.endsWith(extension)) {
            stem = stem.slice(0, -extension.length);
            break;
        }
    }

    const suffixes: string[] = [];
    const parts = stem.split('.');

    while (parts.length > 1 && APPROVED_DOT_SUFFIXES.has(parts.at(-1) ?? '')) {
        suffixes.unshift(parts.pop() ?? '');
    }

    const roleSuffixes = suffixes.filter(suffix => !TEST_DOT_SUFFIXES.has(suffix));
    const extension = fileName.endsWith('.tsx')
        ? '.tsx'
        : fileName.endsWith('.mts')
            ? '.mts'
            : fileName.endsWith('.cts')
                ? '.cts'
                : '.ts';

    return `${expectedStem}${roleSuffixes.length > 0 ? `.${roleSuffixes.join('.')}` : ''}${extension}`;
};

const isMainExportMatchIgnored = (relativePath: string, fileName: string) => {
    if (fileName.endsWith('.d.ts') || isInsideRouteDirectory(relativePath)) {
        return true;
    }

    const stem = stripKnownTypeScriptSuffixes(fileName);

    return IGNORED_MAIN_EXPORT_BASE_NAMES.has(stem);
};

const collectMainExportFileNameIssue = async (absolutePath: string, relativePath: string, fileName: string) => {
    if (isMainExportMatchIgnored(relativePath, fileName)) {
        return null;
    }

    const sourceText = await readFile(absolutePath, 'utf8');
    const sourceFile = ts.createSourceFile(
        absolutePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const mainExport = getMainExportSymbol(relativePath, sourceFile);

    if (!mainExport) {
        return null;
    }

    const actualStem = stripKnownTypeScriptSuffixes(fileName);
    const expectedStem = normalizeExportName(mainExport);

    if (actualStem === expectedStem) {
        return null;
    }

    return {
        path: relativePath,
        expected: `filename must match its single/main export "${mainExport.name}" (expected ${getExpectedMainExportFileName(fileName, expectedStem)})`,
    };
};

const collectNamingIssues = async (directory: string, issues: INamingIssue[]) => {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        const relativePath = relative(process.cwd(), absolutePath);

        if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            if (!isLowerKebab(entry.name)) {
                issues.push({
                    path: relativePath,
                    expected: 'directory names must be lower kebab-case',
                });
            }

            await collectNamingIssues(absolutePath, issues);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = extname(entry.name);

        if (isTypeScriptFileName(entry.name) && !isValidTypeScriptFileName(entry.name)) {
            issues.push({
                path: relativePath,
                expected: 'TypeScript filenames must be camelCase, with only approved dot suffixes',
            });
            continue;
        }

        if (isTypeScriptFileName(entry.name)) {
            const issue = await collectMainExportFileNameIssue(absolutePath, relativePath, entry.name);

            if (issue) {
                issues.push(issue);
            }
        }

        if (extension === '.vue' && !isValidVueFileName(relativePath, entry.name)) {
            issues.push({
                path: relativePath,
                expected: 'Vue components must be PascalCase; Nuxt route files may be lower kebab-case',
            });
        }
    }
};

const issues: INamingIssue[] = [];

function parseRoots(argv = process.argv.slice(2)): string[] {
    const rootsArg = argv.find(argument => argument.startsWith('--roots='));
    if (!rootsArg) {
        return ROOTS;
    }

    const roots = rootsArg
        .slice('--roots='.length)
        .split(',')
        .map(root => root.trim())
        .filter(Boolean);

    if (roots.length === 0) {
        throw new Error('Expected --roots to include at least one root.');
    }

    return roots;
}

for (const root of parseRoots()) {
    await collectNamingIssues(root, issues);
}

if (issues.length > 0) {
    console.error('Naming convention check failed:');

    for (const issue of issues) {
        console.error(`- ${issue.path}: ${issue.expected}`);
    }

    process.exitCode = 1;
} else {
    console.log('Naming convention check passed.');
}
