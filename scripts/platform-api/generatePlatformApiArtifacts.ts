import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PLATFORM_API_DESCRIPTOR,
    PLATFORM_FEATURE_REGISTRY,
    type IPlatformMethodDescriptor,
    type TPlatformMethodKind,
} from '@contracts/platformApiDescriptor';

type TNestedObjectValue = string | TNestedObjectMap;
type TNestedObjectMap = Map<string, TNestedObjectValue>;

function isNestedObjectMap(value: TNestedObjectValue | undefined): value is TNestedObjectMap {
    return value instanceof Map;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const descriptorOutputPath = path.join(
    repoRoot,
    'app/platform/generated/browserPlatformPathDescriptorsGenerated.ts',
);
const lazyOutputPath = path.join(
    repoRoot,
    'app/platform/generated/createLazyBrowserPlatformApiGenerated.ts',
);

const browserImplementedOptionalMethodNames = new Set<string>([
    'createCombinedPdfFromFiles',
    'openFolderDialogStructured',
    'resyncWorkingCopy',
    'showItemInFolderStructured',
]);

const migratedBrowserBindings = new Map<string, boolean>(
    PLATFORM_FEATURE_REGISTRY.flatMap((feature) => {
        const specs: Record<string, {browser: {method: string} | {unsupported: 'omitted'}}> = {
            ...feature.methods,
            ...feature.events,
        };
        return Object.entries(specs).map(([
            name,
            spec,
        ]) => [
            formatPath([
                ...feature.path,
                name,
            ]),
            'method' in spec.browser,
        ] as const);
    }),
);

function formatPath(pathSegments: readonly string[]) {
    return pathSegments.join('.');
}

function variableNameForPath(pathSegments: readonly string[]) {
    return `${pathSegments.map((segment, index) => {
        const sanitizedSegment = segment.replace(/[^a-zA-Z0-9]/gu, '');
        return index === 0
            ? sanitizedSegment
            : sanitizedSegment.charAt(0).toUpperCase() + sanitizedSegment.slice(1);
    }).join('')}Method`;
}

function descriptorAccessorForPath(pathSegments: readonly string[]) {
    return `pathDescriptors.${pathSegments.join('.')}.path`;
}

function helperNameForKind(kind: TPlatformMethodKind) {
    if (kind === 'event') {
        return 'lazyEvent';
    }
    if (kind === 'void') {
        return 'lazyVoid';
    }
    return 'lazyAsync';
}

function createNestedObject(paths: Array<{
    expression: string;
    path: readonly string[];
}>) {
    const root: TNestedObjectMap = new Map();
    for (const entry of paths) {
        let owner = root;
        for (const segment of entry.path.slice(0, -1)) {
            const existing = owner.get(segment);
            if (isNestedObjectMap(existing)) {
                owner = existing;
                continue;
            }
            const child: TNestedObjectMap = new Map();
            owner.set(segment, child);
            owner = child;
        }
        owner.set(entry.path.at(-1)!, entry.expression);
    }
    return root;
}

function renderNestedObject(value: TNestedObjectMap, indentLevel = 0): string {
    const indent = '    '.repeat(indentLevel);
    const childIndent = '    '.repeat(indentLevel + 1);
    const entries = [...value.entries()].map(([
        key,
        child,
    ]) => {
        if (child instanceof Map) {
            return `${childIndent}${key}: ${renderNestedObject(child, indentLevel + 1)}`;
        }
        return `${childIndent}${key}: ${child}`;
    });
    return `{\n${entries.join(',\n')},\n${indent}}`;
}

function renderDescriptorLeaf(descriptor: IPlatformMethodDescriptor) {
    return `{kind: '${descriptor.kind}', path: ${JSON.stringify(descriptor.path)}}`;
}

function getBrowserDescriptors() {
    return PLATFORM_API_DESCRIPTOR.methods
        .filter(descriptor => descriptor.browserLazy === 'forwarded' && isBrowserMethodImplemented(descriptor))
        .map(descriptor => ({
            expression: renderDescriptorLeaf(descriptor),
            path: descriptor.path,
        }));
}

function getDirectBrowserMethodPaths() {
    return PLATFORM_API_DESCRIPTOR.methods
        .filter(descriptor => descriptor.browserLazy === 'direct' && isBrowserMethodImplemented(descriptor))
        .map(descriptor => descriptor.path);
}

function isBrowserMethodImplemented(descriptor: IPlatformMethodDescriptor) {
    const migratedBinding = migratedBrowserBindings.get(formatPath(descriptor.path));
    if (migratedBinding !== undefined) {
        return migratedBinding;
    }
    const methodName = descriptor.path.at(-1);
    return descriptor.required.browser
        || descriptor.browserLazy === 'direct'
        || (methodName !== undefined && browserImplementedOptionalMethodNames.has(methodName));
}

function renderDescriptorOutput() {
    const descriptorObject = renderNestedObject(createNestedObject(getBrowserDescriptors()));
    const directPathRows = getDirectBrowserMethodPaths()
        .map(pathSegments => `    ${JSON.stringify(pathSegments)},`)
        .join('\n');
    return `/* eslint-disable */\n// Generated by scripts/platform-api/generatePlatformApiArtifacts.ts.\n\nexport const browserPlatformPathDescriptorsGenerated = ${descriptorObject} as const;\n\nexport const directBrowserPlatformMemberPathsGenerated = [\n${directPathRows}\n] as const;\n`;
}

function getLazyExpressionForDescriptor(descriptor: IPlatformMethodDescriptor) {
    if (descriptor.aliasOf !== undefined) {
        return variableNameForPath(descriptor.aliasOf);
    }
    const descriptorAccessor = descriptorAccessorForPath(descriptor.path);
    const formattedPath = formatPath(descriptor.path);
    if (formattedPath === 'documentPicker.getPathForFile') {
        return 'getPathForFile';
    }
    if (formattedPath === 'documentPicker.getPathsForFiles') {
        return 'getPathsForFiles';
    }
    if (formattedPath === 'documents.getPathForFile') {
        return variableNameForPath([
            'documentPicker',
            'getPathForFile',
        ]);
    }
    if (formattedPath === 'documents.getPathsForFiles') {
        return variableNameForPath([
            'documentPicker',
            'getPathsForFiles',
        ]);
    }
    if (formattedPath === 'system.getMemoryInfo') {
        return 'getMemoryInfo';
    }
    if (formattedPath === 'host.getResourceProfile') {
        return 'getResourceProfile';
    }
    return `${helperNameForKind(descriptor.kind)}(${descriptorAccessor})`;
}

function renderLazyOutput() {
    const browserMethodDescriptors = PLATFORM_API_DESCRIPTOR.methods.filter(isBrowserMethodImplemented);
    const methodVariables = browserMethodDescriptors
        .map(descriptor => `    const ${variableNameForPath(descriptor.path)} = ${getLazyExpressionForDescriptor(descriptor)};`)
        .join('\n');
    const topLevelObjects = createNestedObject(browserMethodDescriptors.map(descriptor => ({
        expression: variableNameForPath(descriptor.path),
        path: descriptor.path,
    })));
    const apiObject = renderNestedObject(new Map<string, TNestedObjectValue>([
        [
            'manifest',
            'BROWSER_PLATFORM_MANIFEST',
        ],
        ...[...topLevelObjects.entries()].filter(([key]) => key !== 'manifest'),
    ]));
    return `/* eslint-disable */\n// Generated by scripts/platform-api/generatePlatformApiArtifacts.ts.\n\nimport type { IPlatformApi } from '@contracts/platformApi';\nimport { BROWSER_PLATFORM_MANIFEST } from '@contracts/platformManifest';\nimport { browserDocumentStore } from '@app/platform/browserDocumentStore';\nimport type {\n    TBrowserPlatformAsyncMethodPath,\n    TBrowserPlatformEventMethodPath,\n    TBrowserPlatformVoidMethodPath,\n    TMethodAtBrowserPlatformPath,\n} from '@app/platform/browserPlatformPathDescriptors';\nimport { browserPlatformPathDescriptors } from '@app/platform/browserPlatformPathDescriptors';\n\ninterface ILazyBrowserPlatformApiFactoryDeps {\n    lazyAsync: <TPath extends TBrowserPlatformAsyncMethodPath>(path: TPath) => TMethodAtBrowserPlatformPath<TPath>;\n    lazyEvent: <TPath extends TBrowserPlatformEventMethodPath>(path: TPath) => TMethodAtBrowserPlatformPath<TPath>;\n    lazyVoid: <TPath extends TBrowserPlatformVoidMethodPath>(path: TPath) => TMethodAtBrowserPlatformPath<TPath>;\n}\n\nconst pathDescriptors = browserPlatformPathDescriptors;\n\nfunction getPathForFile(file: File) {\n    return browserDocumentStore.getRefForFile(file);\n}\n\nfunction getPathsForFiles(files: File[]) {\n    return files.map(file => browserDocumentStore.getRefForFile(file));\n}\n\nfunction getMemoryInfo() {\n    return null;\n}\n\nfunction getResourceProfile() {\n    return null;\n}\n\nexport function createLazyBrowserPlatformApiGenerated({\n    lazyAsync,\n    lazyEvent,\n    lazyVoid,\n}: ILazyBrowserPlatformApiFactoryDeps) {\n${methodVariables}\n\n    return ${apiObject} satisfies IPlatformApi;\n}\n`;
}

async function writeIfChanged(filePath: string, content: string, check: boolean) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing === content) {
        return false;
    }
    if (check) {
        throw new Error(`${path.relative(repoRoot, filePath)} is stale. Run pnpm run generate:platform-api.`);
    }
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, content);
    return true;
}

async function main() {
    const check = process.argv.includes('--check');
    const descriptorChanged = await writeIfChanged(descriptorOutputPath, renderDescriptorOutput(), check);
    const lazyChanged = await writeIfChanged(lazyOutputPath, renderLazyOutput(), check);
    if (!check && (descriptorChanged || lazyChanged)) {
        console.info('Generated platform API artifacts.');
    }
}

await main();
