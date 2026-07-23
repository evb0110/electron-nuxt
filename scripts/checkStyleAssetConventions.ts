import { readdir } from 'node:fs/promises';
import path from 'node:path';

const STYLE_ASSET_ROOTS = [
    {
        root: 'app/assets/css',
        target: 'app',
    },
    {
        root: 'landing/app/assets/css',
        target: 'landing',
    },
] as const;
const STYLE_ASSET_FILE_PATTERN = /^_?[a-z0-9]+(?:-[a-z0-9]+)*\.(?:css|scss)$/u;

function parseTarget() {
    const target = process.argv.find(argument => argument.startsWith('--target='))?.slice('--target='.length) ?? 'app';
    if (target === 'app' || target === 'landing' || target === 'all') {
        return target;
    }
    throw new Error(`Expected --target to be one of: app, landing, all. Received "${target}".`);
}

async function collectStyleFiles(root: string, directory = root): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectStyleFiles(root, entryPath);
        }
        return entry.isFile() && /\.(?:css|scss)$/u.test(entry.name)
            ? [path.relative(root, entryPath).split(path.sep).join('/')]
            : [];
    }))).flat();
}

const violations: string[] = [];
for (const assetRoot of STYLE_ASSET_ROOTS) {
    const target = parseTarget();
    if (target !== 'all' && target !== assetRoot.target) {
        continue;
    }

    const extensionsByTwin = new Map<string, Set<string>>();
    for (const relativePath of await collectStyleFiles(assetRoot.root)) {
        const extension = path.extname(relativePath);
        const fileName = path.basename(relativePath);
        if (relativePath.startsWith('vendor/') && !STYLE_ASSET_FILE_PATTERN.test(fileName)) {
            violations.push(`${assetRoot.root}/${relativePath}: vendor style asset filenames must be lower kebab-case.`);
        }

        const twin = relativePath
            .slice(0, -extension.length)
            .replace(/(^|\/)_/gu, '$1');
        const extensions = extensionsByTwin.get(twin) ?? new Set<string>();
        extensions.add(extension);
        extensionsByTwin.set(twin, extensions);
    }

    for (const [
        twin,
        extensions,
    ] of extensionsByTwin) {
        if (extensions.has('.css') && extensions.has('.scss')) {
            violations.push(`${assetRoot.root}/${twin}: do not keep both .css and .scss variants for the same style asset.`);
        }
    }
}

if (violations.length > 0) {
    console.error('Cross-file style asset convention violations:');
    for (const violation of violations) {
        console.error(`  ${violation}`);
    }
    process.exitCode = 1;
}
