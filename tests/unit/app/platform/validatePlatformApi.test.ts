import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_PLATFORM_MANIFEST,
    PLATFORM_CONTRACT_VERSION,
} from '@contracts/platformManifest';
import { validatePlatformApi } from '@app/platform/validatePlatformApi';

function createBrowserApiFixture() {
    return {
        manifest: BROWSER_PLATFORM_MANIFEST,
        documents: {
            openDocumentDialog: vi.fn(),
            registerFilesForOpen: vi.fn(),
            openDocumentDirect: vi.fn(),
            readFile: vi.fn(),
            saveFileStructured: vi.fn(),
            recentFiles: {get: vi.fn()},
        },
        pageOps: {delete: vi.fn()},
        imageExport: {exportPdfToImages: vi.fn()},
        ocr: {recognize: vi.fn()},
        search: {run: vi.fn()},
        djvu: {openForViewing: vi.fn()},
        settings: {get: vi.fn()},
        system: {getMemoryInfo: vi.fn()},
        updates: {getState: vi.fn()},
        windowTabs: {transfer: vi.fn()},
        shell: {openExternal: vi.fn()},
        host: {getEnvironment: vi.fn()},
        agent: {onWorkspaceSnapshotRequest: vi.fn()},
    };
}

describe('validatePlatformApi', () => {
    it('accepts a manifest-backed browser platform contract', () => {
        const result = validatePlatformApi(createBrowserApiFixture(), 'browser');

        expect(result).toEqual({
            ok: true,
            failures: [],
        });
    });

    it('rejects stale preload manifests before backend use', () => {
        const api = createBrowserApiFixture();
        api.manifest = {
            ...api.manifest,
            contractVersion: PLATFORM_CONTRACT_VERSION + 1,
        } as typeof api.manifest;

        const result = validatePlatformApi(api, 'browser');

        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'unsupported-contract-version',
            path: 'manifest.contractVersion',
        })]));
    });

    it('requires structured save method when the manifest advertises structured saves', () => {
        const api = createBrowserApiFixture();
        delete (api.documents as {saveFileStructured?: unknown}).saveFileStructured;

        const result = validatePlatformApi(api, 'browser');

        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'missing-required-method',
            path: 'documents.saveFileStructured',
        })]));
    });
});
