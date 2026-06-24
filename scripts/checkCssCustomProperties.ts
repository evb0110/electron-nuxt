import {
    readFile,
    readdir,
} from 'node:fs/promises';
import path from 'node:path';

interface IStyleSourceFile {
    absolutePath: string;
    repoPath: string;
}

interface ICssVarReference {
    name: string;
    line: number;
    hasFallback: boolean;
}

const STYLE_SOURCE_ROOTS = ['app'];
const STYLE_EXTENSIONS = new Set([
    '.vue',
    '.css',
    '.scss',
]);
const IGNORED_REPO_PATH_PREFIXES = ['app/assets/css/vendor/'];
const CANONICAL_APP_TOKEN_SOURCE = 'app/assets/css/main.css';
const CUSTOM_PROPERTY_DECLARATION_PATTERN = /(?:^|[^A-Za-z0-9_-])['"]?(--[A-Za-z0-9_-]+)['"]?\s*:/gu;
const CUSTOM_PROPERTY_NAME_PATTERN = /^\s*(--[A-Za-z0-9_-]+)/u;

const KNOWN_EXTERNAL_UI_TOKENS = new Set([
    '--ui-bg',
    '--ui-bg-accented',
    '--ui-bg-elevated',
    '--ui-bg-inverted',
    '--ui-bg-muted',
    '--ui-border',
    '--ui-border-hover',
    '--ui-color-neutral-50',
    '--ui-color-neutral-100',
    '--ui-color-neutral-200',
    '--ui-color-neutral-300',
    '--ui-color-neutral-400',
    '--ui-color-neutral-500',
    '--ui-color-neutral-600',
    '--ui-color-neutral-700',
    '--ui-color-neutral-800',
    '--ui-color-neutral-900',
    '--ui-color-neutral-950',
    '--ui-color-primary-400',
    '--ui-color-primary-700',
    '--ui-error',
    '--ui-error-50',
    '--ui-error-400',
    '--ui-error-600',
    '--ui-primary',
    '--ui-primary-fg',
    '--ui-radius',
    '--ui-shadow-lg',
    '--ui-success',
    '--ui-text',
    '--ui-text-dimmed',
    '--ui-text-highlighted',
    '--ui-text-muted',
    '--ui-text-toned',
    '--ui-warning',
]);

const SCOPED_TOKENS_REQUIRING_FALLBACK = new Set(['--toolbar-control-height']);

function toRepoPath(filePath: string) {
    return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function isIgnoredRepoPath(repoPath: string) {
    return IGNORED_REPO_PATH_PREFIXES.some(prefix => repoPath.startsWith(prefix));
}

function isStyleSourceFile(filePath: string) {
    return STYLE_EXTENSIONS.has(path.extname(filePath));
}

async function collectStyleSourceFiles(directoryPath: string, files: IStyleSourceFile[] = []) {
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);
        const repoPath = toRepoPath(absolutePath);

        if (isIgnoredRepoPath(repoPath)) {
            continue;
        }

        if (entry.isDirectory()) {
            await collectStyleSourceFiles(absolutePath, files);
            continue;
        }

        if (!entry.isFile() || !isStyleSourceFile(absolutePath)) {
            continue;
        }

        files.push({
            absolutePath,
            repoPath,
        });
    }

    return files;
}

function collectCustomPropertyDeclarations(source: string) {
    const declarations = new Set<string>();

    for (const match of source.matchAll(CUSTOM_PROPERTY_DECLARATION_PATTERN)) {
        const propertyName = match[1];
        if (propertyName !== undefined) {
            declarations.add(propertyName);
        }
    }

    return declarations;
}

function getLineNumber(source: string, index: number) {
    return source.slice(0, index).split('\n').length;
}

function findClosingParenthesis(source: string, startIndex: number) {
    let depth = 0;

    for (let index = startIndex; index < source.length; index += 1) {
        const char = source[index];
        if (char === '(') {
            depth += 1;
            continue;
        }

        if (char !== ')') {
            continue;
        }

        depth -= 1;
        if (depth === 0) {
            return index;
        }
    }

    return -1;
}

function hasTopLevelFallback(body: string) {
    let depth = 0;

    for (const char of body) {
        if (char === '(') {
            depth += 1;
            continue;
        }

        if (char === ')') {
            depth -= 1;
            continue;
        }

        if (char === ',' && depth === 0) {
            return true;
        }
    }

    return false;
}

function collectCssVarReferences(source: string) {
    const references: ICssVarReference[] = [];

    for (let index = 0; index < source.length; index += 1) {
        if (!source.startsWith('var(', index)) {
            continue;
        }

        const endIndex = findClosingParenthesis(source, index);
        if (endIndex === -1) {
            continue;
        }

        const body = source.slice(index + 'var('.length, endIndex);
        const propertyName = body.match(CUSTOM_PROPERTY_NAME_PATTERN)?.[1];
        if (propertyName === undefined) {
            continue;
        }

        references.push({
            name: propertyName,
            line: getLineNumber(source, index),
            hasFallback: hasTopLevelFallback(body),
        });
    }

    return references;
}

function shouldValidateToken(name: string) {
    return name.startsWith('--app-')
        || name.startsWith('--ui-')
        || name.startsWith('--radius-')
        || SCOPED_TOKENS_REQUIRING_FALLBACK.has(name);
}

function isKnownToken(name: string, canonicalTokens: ReadonlySet<string>, localTokens: ReadonlySet<string>) {
    return canonicalTokens.has(name)
        || localTokens.has(name)
        || KNOWN_EXTERNAL_UI_TOKENS.has(name);
}

function isViolation(reference: ICssVarReference, canonicalTokens: ReadonlySet<string>, localTokens: ReadonlySet<string>) {
    if (!shouldValidateToken(reference.name)) {
        return false;
    }

    if (reference.hasFallback) {
        return false;
    }

    return !isKnownToken(reference.name, canonicalTokens, localTokens);
}

async function main() {
    const canonicalTokens = collectCustomPropertyDeclarations(
        await readFile(path.resolve(CANONICAL_APP_TOKEN_SOURCE), 'utf8'),
    );
    const files = await Promise.all(STYLE_SOURCE_ROOTS.map(root => collectStyleSourceFiles(path.resolve(root))));
    const violations: string[] = [];

    for (const file of files.flat()) {
        const source = await readFile(file.absolutePath, 'utf8');
        const localTokens = collectCustomPropertyDeclarations(source);

        for (const reference of collectCssVarReferences(source)) {
            if (!isViolation(reference, canonicalTokens, localTokens)) {
                continue;
            }

            violations.push(`${file.repoPath}:${reference.line}: ${reference.name} is not a known app/UI token, local declaration, or var() with fallback.`);
        }
    }

    if (violations.length === 0) {
        console.log('CSS custom-property reference check passed.');
        return;
    }

    console.error('CSS custom-property reference violations:');
    for (const violation of violations) {
        console.error(`  ${violation}`);
    }
    process.exitCode = 1;
}

await main();
