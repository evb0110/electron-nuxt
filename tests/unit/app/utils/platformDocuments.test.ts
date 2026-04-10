import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const getPlatformApiMock = vi.fn();

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => getPlatformApiMock() }));

describe('platform-documents', () => {
    it('returns the shared documents capability from the platform api', async () => {
        const documentsCapability = { savePdfAs: vi.fn() };
        getPlatformApiMock.mockReturnValueOnce({ documents: documentsCapability });

        const { getDocumentsCapability } = await import('@app/utils/platform-documents');

        expect(getDocumentsCapability()).toBe(documentsCapability);
    });

    it('detects when native print is unavailable for the active platform capability', async () => {
        const { isNativePrintCapabilityUnavailable } = await import('@app/utils/platform-documents');

        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        })).toBe(true);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printer offline',
        })).toBe(false);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            canceled: true,
        })).toBe(false);
    });

    it('refreshes the working copy after save-as only for browser-backed saved refs', async () => {
        const { shouldRefreshWorkingCopyAfterSaveAs } = await import('@app/utils/platform-documents');

        expect(shouldRefreshWorkingCopyAfterSaveAs('browser://documents/source.pdf', 'browser://documents/working.pdf')).toBe(true);
        expect(shouldRefreshWorkingCopyAfterSaveAs('/tmp/source.pdf', '/tmp/working.pdf')).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs('browser://documents/working.pdf', 'browser://documents/working.pdf')).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs(null, 'browser://documents/working.pdf')).toBe(false);
    });
});
