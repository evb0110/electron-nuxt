import {
    describe,
    expect,
    it,
} from 'vitest';
import { PlatformContractError } from '@app/platform/validatePlatformApi';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

describe('createElectronPlatformApiFixture', () => {
    it('generates electron native optional methods from the platform manifest', () => {
        const api = createElectronPlatformApiFixture();

        expect(api.documentFiles?.repairPdf).toEqual(expect.any(Function));
        expect(api.documentFiles?.getPdfNativePageSizes).toEqual(expect.any(Function));
        expect(api.documents.renderPdfNativePagePreview).toEqual(expect.any(Function));
    });

    it('rejects overrides that remove a required manifest method', () => {
        expect(() => createElectronPlatformApiFixture({documents: {readFile: undefined}}))
            .toThrow(PlatformContractError);
    });
});
