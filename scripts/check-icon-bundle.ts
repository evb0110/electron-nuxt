import type { Dirent } from 'node:fs';
import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface IProjectTarget {
    label: string;
    configPath: string;
    sourceDirectories: string[];
}

interface IQuotedTokenMatch {
    token: string;
    tokenStartIndex: number;
}

interface ICollectionHints {
    knownCollections: Set<string>;
    orderedCollections: string[];
}

const SOURCE_FILE_EXTENSIONS = new Set([
    '.vue',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
]);

const QUOTED_TOKEN_PATTERN = /['"`]([a-z0-9:-]+)['"`]/giu;
const TEMPLATE_ICON_ATTRIBUTE_PATTERN = /(^|[\s<])(:)?(icon|name|leading-icon|trailing-icon)\s*=\s*(["'])([\s\S]*?)\4/giu;
const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ICON_CLASS_PATTERN = /^i-[a-z0-9]+(?:-[a-z0-9]+)+$/u;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

const PROJECT_TARGETS: IProjectTarget[] = [
    {
        label: 'app',
        configPath: path.join(projectRoot, 'nuxt.config.ts'),
        sourceDirectories: [path.join(projectRoot, 'app')],
    },
    {
        label: 'landing',
        configPath: path.join(projectRoot, 'landing', 'nuxt.config.ts'),
        sourceDirectories: [path.join(projectRoot, 'landing', 'app')],
    },
];

function toRelative(filePath: string): string {
    return path.relative(projectRoot, filePath);
}

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function extractQuotedTokenMatches(content: string): IQuotedTokenMatch[] {
    const matches: IQuotedTokenMatch[] = [];
    const matcher = new RegExp(QUOTED_TOKEN_PATTERN);
    let match: RegExpExecArray | null = matcher.exec(content);

    while (match !== null) {
        const token = match[1];
        if (token) {
            matches.push({
                token,
                tokenStartIndex: match.index + 1,
            });
        }
        match = matcher.exec(content);
    }

    return matches;
}

function extractVueBlocks(content: string, tagName: 'script' | 'template'): string[] {
    const blocks: string[] = [];
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'giu');
    let match: RegExpExecArray | null = pattern.exec(content);

    while (match !== null) {
        const blockContent = match[1];
        if (blockContent) {
            blocks.push(blockContent);
        }
        match = pattern.exec(content);
    }

    return blocks;
}

function isLikelyScriptIconContext(content: string, tokenStartIndex: number): boolean {
    const prefix = content.slice(Math.max(0, tokenStartIndex - 100), tokenStartIndex);
    return /(?:^|[\s,{(])(?:icon|name|leadingIcon|trailingIcon|leading-icon|trailing-icon)\s*[:=]\s*$/u.test(prefix);
}

function normalizeIconToken(
    rawToken: string,
    collectionHints: ICollectionHints,
    allowUnknownCollection: boolean,
): string | null {
    const token = rawToken.trim().toLowerCase();

    if (ICON_NAME_PATTERN.test(token)) {
        const separatorIndex = token.indexOf(':');
        const collection = token.slice(0, separatorIndex);
        if (allowUnknownCollection || collectionHints.knownCollections.has(collection)) {
            return token;
        }
        return null;
    }

    if (!ICON_CLASS_PATTERN.test(token)) {
        return null;
    }

    const classBody = token.slice(2);
    for (const collection of collectionHints.orderedCollections) {
        if (classBody.startsWith(`${collection}-`)) {
            const iconName = classBody.slice(collection.length + 1);
            if (iconName.length > 0) {
                return `${collection}:${iconName}`;
            }
        }
    }

    if (!allowUnknownCollection) {
        return null;
    }

    const segments = classBody.split('-');
    if (segments.length < 2) {
        return null;
    }

    // Handle popular collections like "simple-icons" when not present in local iconify-json deps.
    if (segments.length >= 3 && segments[1] === 'icons') {
        return `${segments[0]}-${segments[1]}:${segments.slice(2).join('-')}`;
    }

    return `${segments[0]}:${segments.slice(1).join('-')}`;
}

function addUsage(
    usageByIcon: Map<string, Set<string>>,
    rawToken: string,
    filePath: string,
    collectionHints: ICollectionHints,
    allowUnknownCollection: boolean,
) {
    const normalized = normalizeIconToken(rawToken, collectionHints, allowUnknownCollection);
    if (!normalized) {
        return;
    }

    const locations = usageByIcon.get(normalized) ?? new Set<string>();
    locations.add(filePath);
    usageByIcon.set(normalized, locations);
}

function collectScriptUsages(
    content: string,
    filePath: string,
    usageByIcon: Map<string, Set<string>>,
    collectionHints: ICollectionHints,
) {
    for (const match of extractQuotedTokenMatches(content)) {
        addUsage(
            usageByIcon,
            match.token,
            filePath,
            collectionHints,
            isLikelyScriptIconContext(content, match.tokenStartIndex),
        );
    }
}

function collectTemplateUsages(
    content: string,
    filePath: string,
    usageByIcon: Map<string, Set<string>>,
    collectionHints: ICollectionHints,
) {
    const matcher = new RegExp(TEMPLATE_ICON_ATTRIBUTE_PATTERN);
    let match: RegExpExecArray | null = matcher.exec(content);

    while (match !== null) {
        const isBoundAttribute = match[2] === ':';
        const attributeValue = match[5] ?? '';

        if (isBoundAttribute) {
            for (const tokenMatch of extractQuotedTokenMatches(attributeValue)) {
                addUsage(usageByIcon, tokenMatch.token, filePath, collectionHints, true);
            }
        } else {
            addUsage(usageByIcon, attributeValue, filePath, collectionHints, true);
        }

        match = matcher.exec(content);
    }
}

async function collectFilesRecursively(directoryPath: string): Promise<string[]> {
    let entries: Dirent[];

    try {
        entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const filePaths: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            const nestedFiles = await collectFilesRecursively(entryPath);
            filePaths.push(...nestedFiles);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (SOURCE_FILE_EXTENSIONS.has(extension)) {
            filePaths.push(entryPath);
        }
    }

    return filePaths;
}

function extractBundledIconsFromConfig(configContent: string): Set<string> {
    const bundledIcons = new Set<string>();
    for (const { token } of extractQuotedTokenMatches(configContent)) {
        if (ICON_NAME_PATTERN.test(token)) {
            bundledIcons.add(token.toLowerCase());
        }
    }
    return bundledIcons;
}

function extractCollections(icons: Iterable<string>): Set<string> {
    const collections = new Set<string>();
    for (const icon of icons) {
        const separatorIndex = icon.indexOf(':');
        if (separatorIndex > 0) {
            collections.add(icon.slice(0, separatorIndex));
        }
    }
    return collections;
}

function extractInstalledCollections(packageJsonContent: string): Set<string> {
    const parsed = JSON.parse(packageJsonContent) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };

    const installed = new Set<string>();
    const dependencyBuckets = [
        parsed.dependencies ?? {},
        parsed.devDependencies ?? {},
    ];

    for (const dependencies of dependencyBuckets) {
        for (const packageName of Object.keys(dependencies)) {
            if (!packageName.startsWith('@iconify-json/')) {
                continue;
            }
            installed.add(packageName.slice('@iconify-json/'.length));
        }
    }

    return installed;
}

async function checkTarget(target: IProjectTarget, installedCollections: Set<string>) {
    const configContent = await readFile(target.configPath, 'utf8');
    const bundledIcons = extractBundledIconsFromConfig(configContent);
    const bundledCollections = extractCollections(bundledIcons);
    const orderedCollections = uniqueSorted([
        ...installedCollections,
        ...bundledCollections,
    ]).sort((left, right) => right.length - left.length);
    const collectionHints: ICollectionHints = {
        knownCollections: new Set<string>(orderedCollections),
        orderedCollections,
    };

    const usageByIcon = new Map<string, Set<string>>();

    for (const sourceDirectory of target.sourceDirectories) {
        const sourceFiles = await collectFilesRecursively(sourceDirectory);

        for (const sourceFile of sourceFiles) {
            const sourceContent = await readFile(sourceFile, 'utf8');
            const relativePath = toRelative(sourceFile);
            const extension = path.extname(sourceFile).toLowerCase();

            if (extension === '.vue') {
                const scriptBlocks = extractVueBlocks(sourceContent, 'script');
                for (const scriptBlock of scriptBlocks) {
                    collectScriptUsages(scriptBlock, relativePath, usageByIcon, collectionHints);
                }

                const templateBlocks = extractVueBlocks(sourceContent, 'template');
                for (const templateBlock of templateBlocks) {
                    collectTemplateUsages(templateBlock, relativePath, usageByIcon, collectionHints);
                }
                continue;
            }

            collectScriptUsages(sourceContent, relativePath, usageByIcon, collectionHints);
        }
    }

    const usedIcons = uniqueSorted(usageByIcon.keys());
    const missingIcons = usedIcons.filter((icon) => !bundledIcons.has(icon));

    return {
        target,
        missingIcons,
        usageByIcon,
    };
}

async function main() {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf8');
    const installedCollections = extractInstalledCollections(packageJsonContent);

    const results = await Promise.all(
        PROJECT_TARGETS.map(target => checkTarget(target, installedCollections)),
    );

    const hasMissingIcons = results.some(result => result.missingIcons.length > 0);
    if (hasMissingIcons) {
        console.error('Icon bundle coverage check failed.');

        for (const result of results) {
            if (result.missingIcons.length === 0) {
                continue;
            }

            console.error('');
            console.error(`[${result.target.label}] Missing ${result.missingIcons.length} icon(s) in clientBundle.icons (${toRelative(result.target.configPath)}):`);

            for (const icon of result.missingIcons) {
                const usageFiles = uniqueSorted(result.usageByIcon.get(icon) ?? []);
                const displayFiles = usageFiles.slice(0, 3).join(', ');
                const suffix = usageFiles.length > 3 ? ` (+${usageFiles.length - 3} more)` : '';
                console.error(`- ${icon} (used in: ${displayFiles}${suffix})`);
            }
        }

        process.exit(1);
    }

    console.log('Icon bundle coverage check passed for app and landing.');
}

main().catch((error) => {
    console.error('Failed to check icon bundle coverage:', error);
    process.exit(1);
});
