import {
    describe,
    expect,
    it,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { TPlatformApiFixtureOverrides } from '@tests/helpers/createPlatformApiFixture';

function asFixtureOverrides(value: unknown): TPlatformApiFixtureOverrides {
    return value as TPlatformApiFixtureOverrides;
}

describe('createElectronPlatformApiFixture', () => {
    it('generates electron native optional methods from the platform manifest', () => {
        const api = createElectronPlatformApiFixture();

        expect(api.documentFiles?.repairPdf).toEqual(expect.any(Function));
        expect(api.documentFiles?.getPdfNativePageSizes).toEqual(expect.any(Function));
        expect(api.documents.renderPdfNativePagePreview).toEqual(expect.any(Function));
    });

    it('rejects overrides that remove a required manifest method', () => {
        const overrides = asFixtureOverrides({documents: {readFile: undefined}});

        expect(() => createElectronPlatformApiFixture(overrides))
            .toThrow('Missing platform API fixture method documentFiles.readFile');
    });
});
