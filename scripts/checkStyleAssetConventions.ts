import { readdir } from 'node:fs/promises';
import path from 'node:path';

interface IStyleAssetRoot {
    root: string;
    allowedCssFiles: ReadonlySet<string>;
    allowedCssPrefixes: readonly string[];
    target: TStyleAssetTarget;
}

interface IStyleAssetFile {
    absolutePath: string;
    relativePath: string;
    repoPath: string;
}

const STYLE_ASSET_ROOTS: IStyleAssetRoot[] = [
    {
        root: 'app/assets/css',
        allowedCssFiles: new Set(['main.css']),
        allowedCssPrefixes: ['vendor/'],
        target: 'app',
    },
    {
        root: 'landing/app/assets/css',
        allowedCssFiles: new Set(['main.css']),
        allowedCssPrefixes: [],
        target: 'landing',
    },
];

const VALID_TARGETS = [
    'all',
    'app',
    'landing',
] as const;
type TStyleAssetTarget = typeof VALID_TARGETS[number];

const STYLE_EXTENSIONS = new Set([
    '.css',
    '.scss',
]);

const STYLE_ASSET_FILE_NAME_PATTERN = /^_?[a-z0-9]+(?:-[a-z0-9]+)*\.(?:css|scss)$/u;

function toRepoPath(filePath: string) {
    return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function isStyleFile(filePath: string) {
    return STYLE_EXTENSIONS.has(path.extname(filePath));
}

function isStyleAssetTarget(value: string): value is TStyleAssetTarget {
    return (VALID_TARGETS as readonly string[]).includes(value);
}

function parseTarget(argv = process.argv.slice(2)) {
    const targetArg = argv.find(arg => arg.startsWith('--target='));
    const target = targetArg?.slice('--target='.length) ?? 'app';

    if (isStyleAssetTarget(target)) {
        return target;
    }

    throw new Error(`Expected --target to be one of: app, landing, all. Received "${target}".`);
}

function getTargetRoots(target: TStyleAssetTarget) {
    return STYLE_ASSET_ROOTS.filter(root => target === 'all' || root.target === target);
}

function isAllowedCssFile(file: IStyleAssetFile, root: IStyleAssetRoot) {
    return root.allowedCssFiles.has(file.relativePath)
        || root.allowedCssPrefixes.some(prefix => file.relativePath.startsWith(prefix));
}

function getStyleTwinKey(file: IStyleAssetFile, root: IStyleAssetRoot) {
    const directoryPath = path.dirname(file.relativePath);
    const extension = path.extname(file.relativePath);
    const baseName = path.basename(file.relativePath, extension).replace(/^_/u, '');

    return `${root.root}/${directoryPath}/${baseName}`;
}

async function collectStyleAssetFiles(root: IStyleAssetRoot, directoryPath = path.resolve(root.root), files: IStyleAssetFile[] = []) {
    const entries = await readdir(directoryPath, {withFileTypes: true});

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            await collectStyleAssetFiles(root, absolutePath, files);
            continue;
        }

        if (!entry.isFile() || !isStyleFile(absolutePath)) {
            continue;
        }

        files.push({
            absolutePath,
            relativePath: path.relative(path.resolve(root.root), absolutePath).split(path.sep).join('/'),
            repoPath: toRepoPath(absolutePath),
        });
    }

    return files;
}

async function main() {
    const violations: string[] = [];
    const twinExtensionsByKey = new Map<string, Set<string>>();
    const target = parseTarget();

    for (const root of getTargetRoots(target)) {
        const files = await collectStyleAssetFiles(root);

        for (const file of files) {
            const extension = path.extname(file.relativePath);
            const fileName = path.basename(file.relativePath);

            if (!STYLE_ASSET_FILE_NAME_PATTERN.test(fileName)) {
                violations.push(`${file.repoPath}: style asset filenames must be lower kebab-case with an optional Sass partial underscore.`);
            }

            if (extension === '.css' && !isAllowedCssFile(file, root)) {
                violations.push(`${file.repoPath}: app-owned asset styles should use .scss; keep .css for main.css and vendor/generated CSS.`);
            }

            const twinKey = getStyleTwinKey(file, root);
            const twinExtensions = twinExtensionsByKey.get(twinKey) ?? new Set<string>();
            twinExtensions.add(extension);
            twinExtensionsByKey.set(twinKey, twinExtensions);
        }
    }

    for (const [
        twinKey,
        extensions,
    ] of twinExtensionsByKey) {
        if (extensions.has('.css') && extensions.has('.scss')) {
            violations.push(`${twinKey}: do not keep both .css and .scss variants for the same style asset.`);
        }
    }

    if (violations.length === 0) {
        return;
    }

    console.error('Style asset convention violations:');
    for (const violation of violations) {
        console.error(`  ${violation}`);
    }
    process.exitCode = 1;
}

await main();
