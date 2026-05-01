#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const INTERNAL_ROOTS = [
    'app',
    'electron',
    'landing',
    'scripts',
    'packages/contracts',
    'packages/i18n-core',
    'packages/i18n-app',
    'packages/release-selection',
];

const SOURCE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
];

const IGNORED_DIRECTORY_NAMES = new Set([
    'node_modules',
    '.nuxt',
    'nuxt-output',
    '.output',
    'dist',
    'dist-electron',
    '.git',
    '.idea',
    '.tmp',
    '.cache',
    'coverage',
]);

const IGNORED_PATH_SEGMENTS = new Set([
    '.pnpm',
    '.ignored',
]);

const IMPORT_PATTERNS = [
    /\bimport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bexport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];

const INTERNAL_LIKE_PREFIXES = [
    '@app/',
    '@contracts',
    '@contracts/',
    '@electron/',
    '@i18n-core',
    '@i18n-core/',
    '@i18n-app',
    '@i18n-app/',
    '@release-selection',
    '@release-selection/',
    'app/',
    'electron/',
    'landing/',
    'scripts/',
    'packages/contracts/',
    'packages/i18n-core/',
    'packages/i18n-app/',
    'packages/release-selection/',
    '~/',
    '~~/',
];

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function isSourceFile(filePath) {
    if (
        filePath.endsWith('.d.ts')
        || filePath.endsWith('.d.mts')
        || filePath.endsWith('.d.cts')
    ) {
        return false;
    }
    return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

function shouldSkipDirectory(relDir) {
    if (!relDir) {
        return false;
    }
    const segments = toPosixPath(relDir).split('/').filter(Boolean);
    return segments.some(segment => (
        IGNORED_DIRECTORY_NAMES.has(segment)
        || IGNORED_PATH_SEGMENTS.has(segment)
    ));
}

async function collectFiles(rootDir, relDir = '') {
    const scanDir = path.join(rootDir, relDir);
    if (!(await pathExists(scanDir))) {
        return [];
    }

    const entries = await fs.readdir(scanDir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
        const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
        const abs = path.join(rootDir, nextRel);
        if (entry.isDirectory()) {
            if (shouldSkipDirectory(nextRel)) {
                return [];
            }
            return collectFiles(rootDir, nextRel);
        }

        if (entry.isFile() && isSourceFile(abs)) {
            return [toPosixPath(nextRel)];
        }

        return [];
    }));

    return files.flat();
}

function extractImportSpecifiers(sourceText) {
    const specifiers = [];
    for (const pattern of IMPORT_PATTERNS) {
        for (const match of sourceText.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }
    return specifiers;
}

async function resolveWithExtensions(projectRoot, basePath) {
    const candidates = [
        basePath,
        ...SOURCE_EXTENSIONS.map(extension => `${basePath}${extension}`),
        ...SOURCE_EXTENSIONS.map(extension => path.join(basePath, `index${extension}`)),
    ];

    for (const candidate of candidates) {
        const absoluteCandidate = path.join(projectRoot, candidate);
        if (await pathExists(absoluteCandidate)) {
            return toPosixPath(candidate);
        }
    }

    return null;
}

function isWithinRoot(filePath, root) {
    return filePath === root || filePath.startsWith(`${root}/`);
}

function getNuxtSourceRootForFile(sourceFile) {
    if (isWithinRoot(sourceFile, 'landing')) {
        return 'landing';
    }
    if (isWithinRoot(sourceFile, 'app')) {
        return 'app';
    }
    return null;
}

function isInternalLikeSpecifier(specifier) {
    return INTERNAL_LIKE_PREFIXES.some(prefix => specifier.startsWith(prefix));
}

const PACKAGE_ALIAS_RULES = [
    {
        exact: '@contracts',
        prefix: '@contracts/',
        exactTarget: 'packages/contracts/index',
        prefixTarget: 'packages/contracts/',
    },
    {
        exact: '@i18n-core',
        prefix: '@i18n-core/',
        exactTarget: 'packages/i18n-core/index',
        prefixTarget: 'packages/i18n-core/',
    },
    {
        exact: '@i18n-app',
        prefix: '@i18n-app/',
        exactTarget: 'packages/i18n-app/index',
        prefixTarget: 'packages/i18n-app/',
    },
    {
        exact: '@release-selection',
        prefix: '@release-selection/',
        exactTarget: 'packages/release-selection/index',
        prefixTarget: 'packages/release-selection/',
    },
    {
        prefix: '@app/',
        prefixTarget: 'app/',
    },
    {
        prefix: '@electron/',
        prefixTarget: 'electron/',
    },
];

const ROOT_SPECIFIER_PREFIXES = [
    'app/',
    'electron/',
    'landing/',
    'packages/contracts/',
    'packages/i18n-core/',
    'packages/i18n-app/',
    'packages/release-selection/',
];

function resolvePackageAliasSpecifier(projectRoot, specifier) {
    const aliasRule = PACKAGE_ALIAS_RULES.find(rule => (
        specifier === rule.exact
        || (rule.prefix && specifier.startsWith(rule.prefix))
    ));
    if (!aliasRule) {
        return null;
    }

    const candidate = specifier === aliasRule.exact
        ? aliasRule.exactTarget
        : specifier.replace(aliasRule.prefix, aliasRule.prefixTarget);
    return resolveWithExtensions(projectRoot, candidate);
}

function resolveNuxtAliasSpecifier(projectRoot, sourceFile, specifier) {
    const sourceRoot = getNuxtSourceRootForFile(sourceFile);
    if (!sourceRoot) {
        return null;
    }

    if (specifier.startsWith('~/')) {
        const target = sourceRoot === 'landing'
            ? `landing/app/${specifier.slice(2)}`
            : `app/${specifier.slice(2)}`;
        return resolveWithExtensions(projectRoot, target);
    }

    if (specifier.startsWith('~~/')) {
        const target = sourceRoot === 'landing'
            ? `landing/${specifier.slice(3)}`
            : specifier.slice(3);
        return resolveWithExtensions(projectRoot, target);
    }

    return null;
}

function resolveRelativeSpecifier(projectRoot, sourceFile, specifier) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return null;
    }

    const sourceDir = path.dirname(sourceFile);
    const resolved = toPosixPath(path.normalize(path.join(sourceDir, specifier)));
    return resolveWithExtensions(projectRoot, resolved);
}

function resolveRootSpecifier(projectRoot, specifier) {
    return ROOT_SPECIFIER_PREFIXES.some(prefix => specifier.startsWith(prefix))
        ? resolveWithExtensions(projectRoot, specifier)
        : null;
}

async function resolveSpecifier({
    sourceFile,
    specifier,
    projectRoot,
}) {
    const resolvedPackageAlias = await resolvePackageAliasSpecifier(projectRoot, specifier);
    if (resolvedPackageAlias) {
        return resolvedPackageAlias;
    }

    const resolvedNuxtAlias = await resolveNuxtAliasSpecifier(projectRoot, sourceFile, specifier);
    if (resolvedNuxtAlias) {
        return resolvedNuxtAlias;
    }

    const resolvedRelative = await resolveRelativeSpecifier(projectRoot, sourceFile, specifier);
    if (resolvedRelative) {
        return resolvedRelative;
    }

    return resolveRootSpecifier(projectRoot, specifier);
}

function collectRootsFromArgv(argv) {
    const rootArg = argv.find(argument => argument.startsWith('--roots='));
    if (!rootArg) {
        return INTERNAL_ROOTS;
    }

    const requestedRoots = rootArg
        .slice('--roots='.length)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

    return requestedRoots
        .map(root => toPosixPath(path.normalize(root)))
        .filter(root => !path.isAbsolute(root))
        .filter(Boolean);
}

function parseOutputArg(argv) {
    const outputArg = argv.find(argument => argument.startsWith('--output='));
    return outputArg ? outputArg.slice('--output='.length) : null;
}

function parseFormatArg(argv) {
    const formatArg = argv.find(argument => argument.startsWith('--format='));
    if (!formatArg) {
        return 'json';
    }

    const format = formatArg.slice('--format='.length).toLowerCase();
    return format === 'md' ? 'md' : 'json';
}

function isInternalPath(filePath) {
    return INTERNAL_ROOTS.some(root => filePath === root || filePath.startsWith(`${root}/`));
}

function toMarkdown(graph) {
    const lines = [
        '# Dependency Graph',
        '',
        `- Generated: ${new Date().toISOString()}`,
        `- Nodes: ${graph.nodes.length}`,
        `- Edges: ${graph.edges.length}`,
        '',
        '## Edges',
    ];

    for (const edge of graph.edges) {
        lines.push(`- \`${edge.source}\` -> \`${edge.target}\` (\`${edge.specifier}\`)`);
    }

    return `${lines.join('\n')}\n`;
}

export async function buildDependencyGraph({
    projectRoot = process.cwd(),
    roots = INTERNAL_ROOTS,
} = {}) {
    const normalizedRoots = roots.map(root => toPosixPath(path.normalize(root)));
    const files = (
        await Promise.all(normalizedRoots.map(root => collectFiles(projectRoot, root)))
    )
        .flat()
        .sort();

    const nodes = [];
    const edges = [];
    const unresolvedInternalImports = [];

    for (const file of files) {
        const absFile = path.join(projectRoot, file);
        const sourceText = await fs.readFile(absFile, 'utf8');
        const imports = extractImportSpecifiers(sourceText);
        const resolvedImports = await Promise.all(imports.map(async specifier => {
            const target = await resolveSpecifier({
                sourceFile: file,
                specifier,
                projectRoot,
            });
            return {
                specifier,
                target,
            };
        }));

        const internalImports = resolvedImports.filter(entry => entry.target && isInternalPath(entry.target));
        nodes.push({
            file,
            imports: internalImports,
        });

        for (const item of resolvedImports) {
            if (item.target) {
                continue;
            }
            if (!isInternalLikeSpecifier(item.specifier)) {
                continue;
            }
            unresolvedInternalImports.push({
                source: file,
                specifier: item.specifier,
            });
        }

        for (const item of internalImports) {
            edges.push({
                source: file,
                target: item.target,
                specifier: item.specifier,
            });
        }
    }

    return {
        nodes,
        edges,
        unresolvedInternalImports,
    };
}

async function runCli() {
    const argv = process.argv.slice(2);
    const projectRoot = process.cwd();
    const roots = collectRootsFromArgv(argv);
    const output = parseOutputArg(argv);
    const format = parseFormatArg(argv);

    const graph = await buildDependencyGraph({
        projectRoot,
        roots,
    });

    const payload = format === 'md'
        ? toMarkdown(graph)
        : `${JSON.stringify(graph, null, 2)}\n`;

    if (output) {
        const outputPath = path.isAbsolute(output)
            ? output
            : path.join(projectRoot, output);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, payload, 'utf8');
    } else {
        process.stdout.write(payload);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runCli().catch(error => {
        console.error('[dep-graph] Failed to build dependency graph.');
        console.error(error);
        process.exit(1);
    });
}
