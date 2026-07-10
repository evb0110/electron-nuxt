#!/usr/bin/env tsx

import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { platformMethodManifest } from '@contracts/platformMethodManifest';

interface IManifestEntry {
    path: readonly string[];
    kind: string;
}

interface ISourceBlock {
    file: string;
    sourceText: string;
    scriptKind: ts.ScriptKind;
}

interface ISourceInventory {
    fileCount: number;
    propertyChains: Set<string>;
    propertyNames: Set<string>;
    aggregateDocumentsCallSites: string[];
}

const SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
    'node_modules',
    '.nuxt',
    '.output',
    'dist',
    'dist-electron',
    'coverage',
    'generated',
]);

export const AGGREGATE_DOCUMENTS_ALLOWED_FILES = [
    'app/platform/browser-api/createDjvuWorkerFromPath.ts',
    'app/platform/browserPlatformApi.ts',
    'app/platform/lazyBrowserPlatformApi.ts',
    'app/utils/platformDocuments.ts',
    'app/platform/validatePlatformApi.ts',
] as const;

export const AGGREGATE_DOCUMENTS_UNAPPROVED_BASELINE = 0;

const aggregateDocumentsAllowedFileSet = new Set<string>(AGGREGATE_DOCUMENTS_ALLOWED_FILES);

function toPosix(filePath: string) {
    return filePath.split(path.sep).join('/');
}

function isIgnoredAppSource(filePath: string) {
    const normalized = toPosix(filePath);
    const segments = normalized.split('/');
    return segments.some(segment => IGNORED_DIRECTORY_NAMES.has(segment))
        || normalized.endsWith('.d.ts')
        || normalized.endsWith('.d.mts')
        || normalized.endsWith('.d.cts')
        || normalized.includes('/preload/')
        || normalized.includes('/__tests__/')
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
}

function isSourceFile(filePath: string) {
    return SOURCE_EXTENSIONS.has(path.extname(filePath)) && !isIgnoredAppSource(filePath);
}

async function collectSourceFiles(root: string, relativeDir = ''): Promise<string[]> {
    const absoluteDir = path.join(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => {
        const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        if (entry.isDirectory()) {
            if (isIgnoredAppSource(relativePath)) {
                return [];
            }
            return collectSourceFiles(root, relativePath);
        }
        return entry.isFile() && isSourceFile(relativePath)
            ? [toPosix(relativePath)]
            : [];
    }));
    return nested.flat().sort();
}

function getScriptKind(filePath: string, attributes = '') {
    if (attributes.includes('lang="tsx"') || attributes.includes('lang=\'tsx\'') || filePath.endsWith('.tsx')) {
        return ts.ScriptKind.TSX;
    }
    if (attributes.includes('lang="jsx"') || attributes.includes('lang=\'jsx\'') || filePath.endsWith('.jsx')) {
        return ts.ScriptKind.JSX;
    }
    if (/\.[cm]?js$/u.test(filePath)) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

function collectSourceBlocks(file: string, sourceText: string): ISourceBlock[] {
    if (!file.endsWith('.vue')) {
        return [{
            file,
            sourceText,
            scriptKind: getScriptKind(file),
        }];
    }

    const blocks: ISourceBlock[] = [];
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
    for (const match of sourceText.matchAll(scriptPattern)) {
        blocks.push({
            file,
            sourceText: match[2] ?? '',
            scriptKind: getScriptKind(file, match[1] ?? ''),
        });
    }
    return blocks;
}

function getPropertyAccessChain(node: ts.PropertyAccessExpression): string[] {
    const names = [node.name.text];
    let expression: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(expression)) {
        names.unshift(expression.name.text);
        expression = expression.expression;
    }
    if (ts.isIdentifier(expression)) {
        names.unshift(expression.text);
    }
    return names;
}

function isAggregateDocumentsAccess(node: ts.PropertyAccessExpression) {
    return node.name.text === 'documents'
        && !ts.isPropertyAccessExpression(node.parent)
        && !ts.isPropertyAssignment(node.parent)
        && !ts.isShorthandPropertyAssignment(node.parent);
}

function lineAndColumn(sourceFile: ts.SourceFile, node: ts.Node) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${position.line + 1}:${position.character + 1}`;
}

function scanSourceBlock(block: ISourceBlock, inventory: ISourceInventory) {
    const sourceFile = ts.createSourceFile(
        block.file,
        block.sourceText,
        ts.ScriptTarget.Latest,
        true,
        block.scriptKind,
    );

    function visit(node: ts.Node): void {
        if (ts.isPropertyAccessExpression(node)) {
            const chain = getPropertyAccessChain(node);
            for (const name of chain) {
                inventory.propertyNames.add(name);
            }
            for (let index = 0; index < chain.length; index += 1) {
                inventory.propertyChains.add(chain.slice(index).join('.'));
            }
            if (
                isAggregateDocumentsAccess(node)
                && !aggregateDocumentsAllowedFileSet.has(block.file)
            ) {
                inventory.aggregateDocumentsCallSites.push(`${block.file}:${lineAndColumn(sourceFile, node)}`);
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
}

export function collectAggregateDocumentsCallSites(file: string, sourceText: string) {
    const inventory: ISourceInventory = {
        fileCount: 1,
        propertyChains: new Set(),
        propertyNames: new Set(),
        aggregateDocumentsCallSites: [],
    };
    for (const block of collectSourceBlocks(file, sourceText)) {
        scanSourceBlock(block, inventory);
    }
    return inventory.aggregateDocumentsCallSites.sort();
}

export function isAggregateDocumentsBaselineSatisfied(unapprovedCallSiteCount: number) {
    return unapprovedCallSiteCount <= AGGREGATE_DOCUMENTS_UNAPPROVED_BASELINE;
}

function isManifestDescriptor(value: unknown): value is IManifestEntry {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && 'path' in value
        && Array.isArray((value as { path?: unknown }).path);
}

function collectManifestEntries(value: unknown, entries: IManifestEntry[] = []) {
    if (isManifestDescriptor(value)) {
        entries.push({
            kind: String(value.kind),
            path: value.path,
        });
        return entries;
    }
    if (typeof value !== 'object' || value === null) {
        return entries;
    }
    for (const child of Object.values(value)) {
        collectManifestEntries(child, entries);
    }
    return entries;
}

function hasConsumer(entry: IManifestEntry, inventory: ISourceInventory) {
    const fullPath = entry.path.join('.');
    const methodName = entry.path.at(-1);
    return inventory.propertyChains.has(fullPath)
        || (methodName !== undefined && inventory.propertyNames.has(methodName));
}

async function buildInventory() {
    const appRoot = path.join(process.cwd(), 'app');
    const files = await collectSourceFiles(appRoot);
    const inventory: ISourceInventory = {
        fileCount: files.length,
        propertyChains: new Set(),
        propertyNames: new Set(),
        aggregateDocumentsCallSites: [],
    };

    for (const file of files) {
        const sourceText = await readFile(path.join(appRoot, file), 'utf8');
        for (const block of collectSourceBlocks(`app/${file}`, sourceText)) {
            scanSourceBlock(block, inventory);
        }
    }

    inventory.aggregateDocumentsCallSites.sort();
    return inventory;
}

export async function runPlatformManifestConsumerCheck() {
    const entries = collectManifestEntries(platformMethodManifest)
        .sort((a, b) => a.path.join('.').localeCompare(b.path.join('.')));
    const inventory = await buildInventory();
    const zeroConsumerEntries = entries.filter(entry => !hasConsumer(entry, inventory));
    const legacyDocumentsEntries = entries.filter(entry => entry.path[0] === 'documents');

    console.log('[platform-manifest-consumers] Strict aggregate-capability boundary check.');
    console.log(`[platform-manifest-consumers] App source files scanned: ${inventory.fileCount}`);
    console.log(`[platform-manifest-consumers] Manifest entries: ${entries.length}`);
    console.log(`[platform-manifest-consumers] Compatibility-only documents entries: ${legacyDocumentsEntries.length}`);
    console.log(`[platform-manifest-consumers] Entries with no app-side consumer signal: ${zeroConsumerEntries.length}`);
    for (const entry of zeroConsumerEntries.slice(0, 25)) {
        console.log(`  - ${entry.path.join('.')} (${entry.kind})`);
    }
    if (zeroConsumerEntries.length > 25) {
        console.log(`  ... ${zeroConsumerEntries.length - 25} more`);
    }

    console.log(`[platform-manifest-consumers] Unapproved aggregate documents call sites: ${inventory.aggregateDocumentsCallSites.length}`);
    console.log(`[platform-manifest-consumers] Allowed baseline: ${AGGREGATE_DOCUMENTS_UNAPPROVED_BASELINE}`);
    for (const callSite of inventory.aggregateDocumentsCallSites.slice(0, 25)) {
        console.log(`  - ${callSite}`);
    }
    if (inventory.aggregateDocumentsCallSites.length > 25) {
        console.log(`  ... ${inventory.aggregateDocumentsCallSites.length - 25} more`);
    }

    if (!isAggregateDocumentsBaselineSatisfied(inventory.aggregateDocumentsCallSites.length)) {
        console.error('[platform-manifest-consumers] New aggregate documents capability access is forbidden. Use a narrow capability or explicitly approve the access at the platform boundary.');
        return false;
    }

    return true;
}

const isDirectRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
    runPlatformManifestConsumerCheck()
        .then((passed) => {
            if (!passed) {
                process.exitCode = 1;
            }
        })
        .catch((error: unknown) => {
            console.error('[platform-manifest-consumers] Unexpected failure.');
            console.error(error);
            process.exitCode = 1;
        });
}
