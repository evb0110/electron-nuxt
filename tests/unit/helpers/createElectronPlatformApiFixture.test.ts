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
});
