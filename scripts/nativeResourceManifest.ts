import path from 'node:path';

export const NATIVE_RESOURCE_PLATFORMS = [
    'darwin',
    'linux',
    'win32',
] as const;

export const NATIVE_RESOURCE_ARCHES = [
    'x64',
    'arm64',
] as const;

export type TNativeResourcePlatform = typeof NATIVE_RESOURCE_PLATFORMS[number];
export type TNativeResourceArch = typeof NATIVE_RESOURCE_ARCHES[number];
export type TNativeResourcePlatformArch = `${TNativeResourcePlatform}-${TNativeResourceArch}`;
export type TNativeResourcePathType = 'directory' | 'file';

export const NATIVE_TOOL_RESOURCE_FAMILY_IDS = [
    'tesseract',
    'poppler',
    'qpdf',
    'djvulibre',
    'pdf-image-combine',
    'pdf-page-ops',
    'pdf-search',
] as const;

export type TNativeToolResourceFamilyId = typeof NATIVE_TOOL_RESOURCE_FAMILY_IDS[number];
export type TGeneratedNativeToolResourceFamilyId = Extract<
    TNativeToolResourceFamilyId,
    'pdf-image-combine' | 'pdf-page-ops' | 'pdf-search'
>;

export interface INativeResourceTarget {
    arch: TNativeResourceArch;
    exeSuffix: '' | '.exe';
    platform: TNativeResourcePlatform;
    platformArch: TNativeResourcePlatformArch;
}

export interface INativeToolResourceFamily {
    id: TNativeToolResourceFamilyId;
    label: string;
    sourceRootSegments: readonly string[];
    stagedRootSegments: readonly string[];
    sourceKind: 'checked-in' | 'generated';
}

export interface IGeneratedNativeToolResource {
    binaryName: string;
    crateName: string;
    familyId: TGeneratedNativeToolResourceFamilyId;
    stagingName: string;
}

interface IRequiredNativeSourceMatrixEntryDefinition {
    kind: 'required';
    label: string;
    pathSegments: readonly string[];
    platforms?: readonly TNativeResourcePlatform[];
    type: TNativeResourcePathType;
}

interface ISkippedNativeSourceMatrixEntryDefinition {
    kind: 'skip';
    label: string;
    platforms: readonly TNativeResourcePlatform[];
    reason: string;
}

export type TNativeSourceMatrixEntryDefinition =
    | IRequiredNativeSourceMatrixEntryDefinition
    | ISkippedNativeSourceMatrixEntryDefinition;

export type TNativeSourceMatrixCheckEntry =
    | {
        kind: 'required';
        label: string;
        path: string;
        type: TNativeResourcePathType;
    }
    | {
        kind: 'skip';
        label: string;
        reason: string;
    };

export const NATIVE_RESOURCE_PLATFORM_ARCHES = [
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
    'win32-arm64',
] as const satisfies readonly TNativeResourcePlatformArch[];

export const NATIVE_TOOL_RESOURCE_FAMILIES = [
    {
        id: 'tesseract',
        label: 'Tesseract native tools',
        sourceKind: 'checked-in',
        sourceRootSegments: [
            'resources',
            'tesseract',
        ],
        stagedRootSegments: ['tesseract'],
    },
    {
        id: 'poppler',
        label: 'Poppler native tools',
        sourceKind: 'checked-in',
        sourceRootSegments: [
            'resources',
            'poppler',
        ],
        stagedRootSegments: ['poppler'],
    },
    {
        id: 'qpdf',
        label: 'qpdf native tools',
        sourceKind: 'checked-in',
        sourceRootSegments: [
            'resources',
            'qpdf',
        ],
        stagedRootSegments: ['qpdf'],
    },
    {
        id: 'djvulibre',
        label: 'DjVuLibre native tools',
        sourceKind: 'checked-in',
        sourceRootSegments: [
            'resources',
            'djvulibre',
        ],
        stagedRootSegments: ['djvulibre'],
    },
    {
        id: 'pdf-image-combine',
        label: 'PDF image combine native tool',
        sourceKind: 'generated',
        sourceRootSegments: [
            '.tmp',
            'pdf-image-combine',
        ],
        stagedRootSegments: ['pdf-image-combine'],
    },
    {
        id: 'pdf-page-ops',
        label: 'PDF page ops native tool',
        sourceKind: 'generated',
        sourceRootSegments: [
            '.tmp',
            'pdf-page-ops',
        ],
        stagedRootSegments: ['pdf-page-ops'],
    },
    {
        id: 'pdf-search',
        label: 'PDF search native tool',
        sourceKind: 'generated',
        sourceRootSegments: [
            '.tmp',
            'pdf-search',
        ],
        stagedRootSegments: ['pdf-search'],
    },
] as const satisfies readonly INativeToolResourceFamily[];

export const GENERATED_NATIVE_TOOL_RESOURCES = [
    {
        binaryName: 'evb-pdf-image-combine',
        crateName: 'pdf-image-combine',
        familyId: 'pdf-image-combine',
        stagingName: 'pdf-image-combine',
    },
    {
        binaryName: 'evb-pdf-page-ops',
        crateName: 'pdf-page-ops',
        familyId: 'pdf-page-ops',
        stagingName: 'pdf-page-ops',
    },
    {
        binaryName: 'evb-pdf-search',
        crateName: 'pdf-search',
        familyId: 'pdf-search',
        stagingName: 'pdf-search',
    },
] as const satisfies readonly IGeneratedNativeToolResource[];

export const NATIVE_SOURCE_MATRIX_ENTRIES = [
    {
        kind: 'required',
        label: 'tesseract',
        pathSegments: [
            'resources',
            'tesseract',
            '{tag}',
            'bin',
            'tesseract{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'unpaper',
        pathSegments: [
            'resources',
            'tesseract',
            '{tag}',
            'bin',
            'unpaper{exeSuffix}',
        ],
        platforms: [
            'darwin',
            'linux',
        ],
        type: 'file',
    },
    {
        kind: 'skip',
        label: 'unpaper',
        platforms: ['win32'],
        reason: 'not bundled on Windows',
    },
    {
        kind: 'required',
        label: 'pdfinfo',
        pathSegments: [
            'resources',
            'poppler',
            '{tag}',
            'bin',
            'pdfinfo{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'pdftoppm',
        pathSegments: [
            'resources',
            'poppler',
            '{tag}',
            'bin',
            'pdftoppm{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'pdftotext',
        pathSegments: [
            'resources',
            'poppler',
            '{tag}',
            'bin',
            'pdftotext{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'pdftocairo',
        pathSegments: [
            'resources',
            'poppler',
            '{tag}',
            'bin',
            'pdftocairo{exeSuffix}',
        ],
        platforms: ['win32'],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'poppler data directory',
        pathSegments: [
            'resources',
            'poppler',
            '{tag}',
            'share',
            'poppler',
        ],
        platforms: ['win32'],
        type: 'directory',
    },
    {
        kind: 'required',
        label: 'qpdf',
        pathSegments: [
            'resources',
            'qpdf',
            '{tag}',
            'bin',
            'qpdf{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'ddjvu',
        pathSegments: [
            'resources',
            'djvulibre',
            '{tag}',
            'bin',
            'ddjvu{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'djvused',
        pathSegments: [
            'resources',
            'djvulibre',
            '{tag}',
            'bin',
            'djvused{exeSuffix}',
        ],
        type: 'file',
    },
    {
        kind: 'required',
        label: 'djvudump',
        pathSegments: [
            'resources',
            'djvulibre',
            '{tag}',
            'bin',
            'djvudump{exeSuffix}',
        ],
        type: 'file',
    },
] as const satisfies readonly TNativeSourceMatrixEntryDefinition[];

export function isNativeResourcePlatform(value: string): value is TNativeResourcePlatform {
    return (NATIVE_RESOURCE_PLATFORMS as readonly string[]).includes(value);
}

export function isNativeResourceArch(value: string): value is TNativeResourceArch {
    return (NATIVE_RESOURCE_ARCHES as readonly string[]).includes(value);
}

export function getNativeExecutableSuffix(platform: TNativeResourcePlatform) {
    return platform === 'win32' ? '.exe' : '';
}

export function parseNativeResourcePlatformArch(tag: string): INativeResourceTarget {
    const segments = tag.split('-');
    const platform = segments[0];
    const arch = segments[1];

    if (segments.length !== 2 || !platform || !arch) {
        throw new Error(`Unsupported native resource platform/arch tag: ${tag}`);
    }
    if (!isNativeResourcePlatform(platform)) {
        throw new Error(`Unsupported native resource platform in tag: ${tag}`);
    }
    if (!isNativeResourceArch(arch)) {
        throw new Error(`Unsupported native resource architecture in tag: ${tag}`);
    }

    return {
        arch,
        exeSuffix: getNativeExecutableSuffix(platform),
        platform,
        platformArch: `${platform}-${arch}`,
    };
}

function entryAppliesToPlatform(
    entry: TNativeSourceMatrixEntryDefinition,
    platform: TNativeResourcePlatform,
) {
    return !entry.platforms || entry.platforms.includes(platform);
}

function renderNativeResourcePath(
    pathSegments: readonly string[],
    target: INativeResourceTarget,
) {
    return path.posix.join(
        ...pathSegments.map(segment => segment
            .replaceAll('{tag}', target.platformArch)
            .replaceAll('{exeSuffix}', target.exeSuffix)),
    );
}

export function getNativeSourceMatrixCheckEntries(tag: string): TNativeSourceMatrixCheckEntry[] {
    const target = parseNativeResourcePlatformArch(tag);

    return NATIVE_SOURCE_MATRIX_ENTRIES
        .filter(entry => entryAppliesToPlatform(entry, target.platform))
        .map((entry): TNativeSourceMatrixCheckEntry => {
            if (entry.kind === 'skip') {
                return {
                    kind: 'skip',
                    label: entry.label,
                    reason: entry.reason,
                };
            }

            return {
                kind: 'required',
                label: entry.label,
                path: renderNativeResourcePath(entry.pathSegments, target),
                type: entry.type,
            };
        });
}
