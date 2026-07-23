import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getPlatformDocumentCapabilityMirrors,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApi';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { TPlatformApiFixtureOverrides } from '@tests/helpers/createPlatformApiFixture';

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

function formatPath(path: readonly string[]) {
    return path.join('.');
}

function asFixtureOverrides(value: unknown): TPlatformApiFixtureOverrides {
    return value as TPlatformApiFixtureOverrides;
}

describe('createElectronPlatformApiFixture', () => {
    it('creates descriptor-complete callable methods', () => {
        const api = createElectronPlatformApiFixture();

        for (const descriptor of PLATFORM_API_DESCRIPTOR.methods) {
            expect(
                readPath(api, descriptor.path),
                formatPath(descriptor.path),
            ).toEqual(expect.any(Function));
        }
    });

    it('keeps split and legacy document mirrors on the same function', () => {
        const api = createElectronPlatformApiFixture();

        for (const {
            legacyPath,
            splitPath,
        } of getPlatformDocumentCapabilityMirrors()) {
            expect(readPath(api, legacyPath), formatPath(legacyPath)).toBe(readPath(api, splitPath));
        }
    });

    it('deep-merges split overrides into legacy documents unless legacy is explicit', () => {
        const registerFilesForOpen = vi.fn(async () => ['/tmp/split.pdf']);
        const openDocumentDialog = vi.fn(async () => null);
        const api = createElectronPlatformApiFixture({
            documentPicker: {registerFilesForOpen},
            documents: {openDocumentDialog},
        });

        expect(api.documentPicker?.registerFilesForOpen).toBe(registerFilesForOpen);
        expect(api.documents.registerFilesForOpen).toBe(registerFilesForOpen);
        expect(api.documents.openDocumentDialog).toBe(openDocumentDialog);
        expect(api.documentPicker?.openDocumentDialog).toBe(openDocumentDialog);
        expect(api.documents.recentFiles.remove).toEqual(expect.any(Function));
    });

    it('generates electron native optional methods from the platform manifest', () => {
        const api = createElectronPlatformApiFixture();

        expect(api.documentFiles?.repairPdf).toEqual(expect.any(Function));
        expect(api.documentFiles?.getPdfOpeningGeometry).toEqual(expect.any(Function));
        expect(api.documentFiles?.getPdfNativePageSizes).toEqual(expect.any(Function));
        expect(api.documentFiles?.cancelPdfNativePagePreview).toEqual(expect.any(Function));
        expect(api.documents.renderPdfNativePagePreview).toEqual(expect.any(Function));
    });

    it('uses migrated schema examples for Search defaults', async () => {
        const api = createElectronPlatformApiFixture();
        await expect(api.search.run('/tmp/example.pdf', 'needle'))
            .resolves.toEqual({
                results: [],
                truncated: false,
            });
        await expect(api.search.warmIndex('/tmp/example.pdf')).resolves.toBe(true);
        await expect(api.search.cancel()).resolves.toEqual({canceled: false});
        await expect(api.search.resetCache()).resolves.toBe(true);
        expect(api.search.onProgress(() => undefined)).toEqual(expect.any(Function));
    });

    it('rejects overrides that remove a required manifest method', () => {
        const overrides = asFixtureOverrides({documents: {readFile: undefined}});

        expect(() => createElectronPlatformApiFixture(overrides))
            .toThrow('Missing platform API fixture method documentFiles.readFile');
    });

    it('rejects unsupported default calls instead of silently resolving undefined', async () => {
        const api = createElectronPlatformApiFixture();

        await expect(api.shell.openExternal('https://example.test'))
            .rejects.toThrow('Unsupported platform API fixture call: shell.openExternal');
    });
});
