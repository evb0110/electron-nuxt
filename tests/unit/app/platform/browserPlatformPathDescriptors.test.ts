import {isRecord} from '@contracts/runtimeGuards';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { browserPlatformApi } from '@app/platform/browserPlatformApi';
import { lazyBrowserPlatformApi } from '@app/platform/lazyBrowserPlatformApi';
import {
    browserPlatformPathDescriptors,
    browserPlatformPathDescriptorList,
    directBrowserPlatformMemberPaths,
} from '@app/platform/browserPlatformPathDescriptors';

function formatPath(path: readonly string[]) {
    return path.join('.');
}


function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const key of path) {
        if (!isRecord(value)) {
            return undefined;
        }
        value = value[key];
    }
    return value;
}

function collectCallablePaths(
    value: unknown,
    prefix: readonly string[] = [],
    paths: string[] = [],
) {
    if (!isRecord(value)) {
        return paths;
    }

    for (const [
        key,
        child,
    ] of Object.entries(value)) {
        const childPath = [
            ...prefix,
            key,
        ] as const;
        if (typeof child === 'function') {
            paths.push(formatPath(childPath));
            continue;
        }
        collectCallablePaths(child, childPath, paths);
    }

    return paths;
}

type TDescriptorKind = 'async' | 'event' | 'void';

interface IDescriptorLike {
    kind: TDescriptorKind;
    path: readonly string[];
}

interface IPathMirror {
    splitPath: readonly string[];
    legacyPath: readonly string[];
}

const splitDocumentCapabilityNames = [
    'documentPicker',
    'documentOpen',
    'documentWorkingCopy',
    'documentFiles',
    'documentPdf',
    'documentRecentFiles',
    'documentWindow',
    'documentMenu',
] as const;

const directDocumentPathMirrors = [
    {
        splitPath: [
            'documentPicker',
            'getPathForFile',
        ],
        legacyPath: [
            'documents',
            'getPathForFile',
        ],
    },
    {
        splitPath: [
            'documentPicker',
            'getPathsForFiles',
        ],
        legacyPath: [
            'documents',
            'getPathsForFiles',
        ],
    },
] as const satisfies readonly IPathMirror[];

function isDescriptorLike(value: unknown): value is IDescriptorLike {
    return isRecord(value)
        && (value.kind === 'async' || value.kind === 'event' || value.kind === 'void')
        && Array.isArray(value.path)
        && value.path.every(pathPart => typeof pathPart === 'string');
}

function collectDescriptorLikes(
    value: unknown,
    descriptors: IDescriptorLike[] = [],
) {
    if (isDescriptorLike(value)) {
        descriptors.push(value);
        return descriptors;
    }
    if (!isRecord(value)) {
        return descriptors;
    }

    for (const child of Object.values(value)) {
        collectDescriptorLikes(child, descriptors);
    }

    return descriptors;
}

function collectSplitDocumentDescriptorMirrors() {
    return splitDocumentCapabilityNames.flatMap((capabilityName) =>
        collectDescriptorLikes(browserPlatformPathDescriptors[capabilityName]).map((descriptor) => {
            const legacyPath = [
                'documents',
                ...descriptor.path.slice(1),
            ];
            return {
                kind: descriptor.kind,
                legacyPath,
                splitPath: descriptor.path,
            };
        }),
    );
}

describe('browser platform path descriptors', () => {
    it('enumerates unique lazy bridge paths', () => {
        const paths = browserPlatformPathDescriptorList.map(descriptor => formatPath(descriptor.path));

        expect(new Set(paths).size).toBe(paths.length);
        expect(paths).toContain('documentPicker.openDocumentDialog');
        expect(paths).toContain('documentOpen.openDocumentDirect');
        expect(paths).toContain('documentFiles.readTextFile');
        expect(paths).toContain('documentPdf.validatePdfPath');
        expect(paths).toContain('documentRecentFiles.recentFiles.get');
        expect(paths).toContain('documentWindow.showItemInFolder');
        expect(paths).toContain('documentMenu.onMenuSave');
        expect(paths).toContain('documents.openDocumentDialog');
        expect(paths).toContain('documents.recentFiles.get');
        expect(paths).toContain('ocr.preprocessing.validate');
        expect(paths).toContain('windowTabs.notifyRendererReady');
        expect(paths).toContain('agent.onAssistantEvent');
    });

    it('resolves every descriptor against the lazy and real browser platform APIs', () => {
        for (const descriptor of browserPlatformPathDescriptorList) {
            const path = formatPath(descriptor.path);

            expect(readPath(lazyBrowserPlatformApi, descriptor.path), `lazy ${path}`).toEqual(expect.any(Function));
            expect(readPath(browserPlatformApi, descriptor.path), `browser ${path}`).toEqual(expect.any(Function));
        }
    });

    it('keeps lazy and real browser callable surfaces aligned with explicit direct members', () => {
        const descriptorPaths = browserPlatformPathDescriptorList.map(descriptor => formatPath(descriptor.path));
        const directPaths = directBrowserPlatformMemberPaths.map(formatPath);
        const expectedPaths = [
            ...descriptorPaths,
            ...directPaths,
        ].sort();

        expect(collectCallablePaths(lazyBrowserPlatformApi).sort()).toEqual(expectedPaths);
        expect(collectCallablePaths(browserPlatformApi).sort()).toEqual(expectedPaths);
    });

    it('keeps direct browser-only members outside the forwarding descriptor list', () => {
        const descriptorPaths = new Set(
            browserPlatformPathDescriptorList.map(descriptor => formatPath(descriptor.path)),
        );

        for (const path of directBrowserPlatformMemberPaths) {
            expect(descriptorPaths.has(formatPath(path))).toBe(false);
            expect(readPath(lazyBrowserPlatformApi, path), `lazy ${formatPath(path)}`).toEqual(expect.any(Function));
            expect(readPath(browserPlatformApi, path), `browser ${formatPath(path)}`).toEqual(expect.any(Function));
        }

        expect(lazyBrowserPlatformApi.system.getMemoryInfo()).toBeNull();
        expect(browserPlatformApi.system.getMemoryInfo()).toBeNull();
    });

    it('keeps split document descriptor kinds aligned with legacy documents descriptors', () => {
        const mirroredDescriptors = collectSplitDocumentDescriptorMirrors();

        expect(mirroredDescriptors.length).toBeGreaterThan(0);

        for (const {
            kind,
            legacyPath,
            splitPath,
        } of mirroredDescriptors) {
            const legacyDescriptor = readPath(browserPlatformPathDescriptors, legacyPath);

            expect(
                isDescriptorLike(legacyDescriptor),
                `legacy descriptor ${formatPath(legacyPath)} for ${formatPath(splitPath)}`,
            ).toBe(true);
            if (isDescriptorLike(legacyDescriptor)) {
                expect(legacyDescriptor.kind, formatPath(splitPath)).toBe(kind);
            }
        }
    });

    it('composes split document fields from the same legacy functions', () => {
        const mirroredPaths = [
            ...collectSplitDocumentDescriptorMirrors(),
            ...directDocumentPathMirrors,
        ];

        for (const {
            splitPath,
            legacyPath,
        } of mirroredPaths) {
            expect(readPath(browserPlatformApi, splitPath), `browser ${formatPath(splitPath)}`).toBe(
                readPath(browserPlatformApi, legacyPath),
            );
            expect(readPath(lazyBrowserPlatformApi, splitPath), `lazy ${formatPath(splitPath)}`).toBe(
                readPath(lazyBrowserPlatformApi, legacyPath),
            );
        }
    });
});
