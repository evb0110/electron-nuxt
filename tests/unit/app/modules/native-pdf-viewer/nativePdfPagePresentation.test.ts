import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { preloadNativePdfPageObjectUrl } from '@app/modules/native-pdf-viewer/runtime/nativePdfPagePresentation';
import { revokeNativePdfPageObjectUrl } from '@app/modules/native-pdf-viewer/runtime/revokeNativePdfPageObjectUrl';
import { BrowserLogger } from '@app/utils/browserLogger';

describe('native PDF page presentation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('releases image handlers after preload settles', async () => {
        const images: TestImage[] = [];
        class TestImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            constructor() {
                images.push(this);
            }

            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('Image', TestImage);

        await expect(preloadNativePdfPageObjectUrl('blob:page-1')).resolves.toBeUndefined();
        const [image] = images;
        expect(image).toBeDefined();
        expect(image?.onload).toBeNull();
        expect(image?.onerror).toBeNull();
    });

    it('releases image handlers after preload fails', async () => {
        const images: TestImage[] = [];
        class TestImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            constructor() {
                images.push(this);
            }

            set src(_value: string) {
                queueMicrotask(() => this.onerror?.());
            }
        }
        vi.stubGlobal('Image', TestImage);

        await expect(preloadNativePdfPageObjectUrl('blob:page-2'))
            .rejects.toThrow('Failed to decode PDF page preview');
        const [image] = images;
        expect(image).toBeDefined();
        expect(image?.onload).toBeNull();
        expect(image?.onerror).toBeNull();
    });

    it('contains source revocation failures', () => {
        const failure = new Error('revocation failed');
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => undefined);
        const revokeObjectURL = vi.fn(() => { throw failure; });
        const source = {revokeObjectURL};

        expect(() => revokeNativePdfPageObjectUrl(source, 3, 'blob:page-3')).not.toThrow();
        expect(source.revokeObjectURL).toHaveBeenCalledWith('blob:page-3');
        expect(warn).toHaveBeenCalledWith(
            'native-pdf-viewer',
            'Failed to revoke PDF page URL',
            {
                pageNumber: 3,
                error: failure,
            },
        );
    });
});
