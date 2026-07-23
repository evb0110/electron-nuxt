import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getPlatformDocumentCapabilityMirrors,
    PLATFORM_API_DESCRIPTOR,
    type IPlatformApi,
} from '@contracts/platformApi';
import { browserPlatformApi } from '@app/platform/browserPlatformApi';
import { lazyBrowserPlatformApi } from '@app/platform/lazyBrowserPlatformApi';
import {
    browserPlatformPathDescriptorList,
    directBrowserPlatformMemberPaths,
} from '@app/platform/browserPlatformPathDescriptors';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

function formatPath(path: readonly string[]) {
    return path.join('.');
}

function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const segment of path) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

function collectCallablePaths(
    value: unknown,
    prefix: readonly string[] = [],
    paths: string[] = [],
) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return paths;
    }
    for (const [
        key,
        child,
    ] of Object.entries(value)) {
        const childPath = [
            ...prefix,
            key,
        ];
        if (typeof child === 'function') {
            paths.push(formatPath(childPath));
            continue;
        }
        collectCallablePaths(child, childPath, paths);
    }
    return paths;
}

function expectCallablePathParity(
    api: IPlatformApi,
    expectedPaths: ReadonlyArray<readonly string[]>,
) {
    const formattedExpectedPaths = expectedPaths.map(formatPath).sort();
    expect(collectCallablePaths(api).sort()).toEqual(formattedExpectedPaths);
    for (const path of expectedPaths) {
        expect(readPath(api, path), formatPath(path)).toEqual(expect.any(Function));
    }
}

function expectDocumentAliasIdentity(api: IPlatformApi) {
    for (const {
        legacyPath,
        splitPath,
    } of getPlatformDocumentCapabilityMirrors()) {
        const splitMethod = readPath(api, splitPath);
        const legacyMethod = readPath(api, legacyPath);
        if (typeof splitMethod === 'function' || typeof legacyMethod === 'function') {
            expect(legacyMethod, `${formatPath(legacyPath)} -> ${formatPath(splitPath)}`).toBe(splitMethod);
        }
    }
}

async function createMockedElectronApi() {
    const fixture = createElectronPlatformApiFixture();
    vi.doMock('@electron/features/documents/createDocumentsPreloadClient', () => ({createDocumentsPreloadClient: () => fixture.documents}));
    vi.doMock('@electron/features/documents/createDocumentsPreloadPageOpsClient', () => ({createDocumentsPreloadPageOpsClient: () => fixture.pageOps}));
    vi.doMock('@electron/features/image-export/createImageExportPreloadClient', () => ({createImageExportPreloadClient: () => fixture.imageExport}));
    vi.doMock('@electron/features/ocr/createOcrPreloadClient', () => ({createOcrPreloadClient: () => fixture.ocr}));
    vi.doMock('@electron/features/djvu/createDjvuPreloadClient', () => ({createDjvuPreloadClient: () => fixture.djvu}));
    vi.doMock('@electron/features/agent/createAgentPreloadClient', () => ({createAgentPreloadClient: () => fixture.agent}));
    vi.doMock('@electron/preload/debugLogBuffer', () => ({getDebugLogMessages: () => []}));

    const { createElectronApi } = await import('@electron/preload/createElectronApi');
    return createElectronApi({
        invoke: vi.fn(async () => undefined),
        on: vi.fn(),
        send: vi.fn(),
    } as never, {getPathForFile: vi.fn(() => '/tmp/mock.pdf')});
}

describe('platform API contract parity', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps browser and lazy browser callable surfaces aligned with generated browser descriptors', () => {
        const browserPaths = [
            ...browserPlatformPathDescriptorList.map(descriptor => descriptor.path),
            ...directBrowserPlatformMemberPaths,
        ];

        expectCallablePathParity(browserPlatformApi, browserPaths);
        expectCallablePathParity(lazyBrowserPlatformApi, browserPaths);
        expectDocumentAliasIdentity(browserPlatformApi);
        expectDocumentAliasIdentity(lazyBrowserPlatformApi);
    });

    it('keeps the Electron fixture descriptor-complete', () => {
        const api = createElectronPlatformApiFixture();
        const descriptorPaths = PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path);

        expectCallablePathParity(api, descriptorPaths);
        expectDocumentAliasIdentity(api);
    });

    it('keeps mocked Electron preload descriptor-complete', async () => {
        const api = await createMockedElectronApi();
        const descriptorPaths = PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path);

        expectCallablePathParity(api, descriptorPaths);
        expectDocumentAliasIdentity(api);
    });
});
