import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { decodeBrowserImageBlob } from '@app/platform/browser-api/browser-image-decode';

describe('decodeBrowserImageBlob', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses createImageBitmap when the runtime provides it', async () => {
        const bitmap = { close: vi.fn() };
        const createImageBitmapMock = vi.fn(async () => bitmap);
        const blob = new Blob(['image'], { type: 'image/png' });
        vi.stubGlobal('createImageBitmap', createImageBitmapMock);

        await expect(decodeBrowserImageBlob(blob, { fallbackErrorMessage: 'fallback failed' })).resolves.toBe(bitmap);

        expect(createImageBitmapMock).toHaveBeenCalledWith(blob);
    });

    it('falls back to an HTML image and revokes the object URL after load', async () => {
        const createObjectURL = vi.fn(() => 'blob:image');
        const revokeObjectURL = vi.fn();
        const createdImages: FakeImage[] = [];

        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            src = '';

            constructor() {
                createdImages.push(this);
            }
        }

        vi.stubGlobal('createImageBitmap', undefined);
        vi.stubGlobal('document', {});
        vi.stubGlobal('URL', {
            createObjectURL,
            revokeObjectURL,
        });
        vi.stubGlobal('Image', FakeImage);

        const decodePromise = decodeBrowserImageBlob(new Blob(['image']), { fallbackErrorMessage: 'fallback failed' });
        const createdImage = createdImages[0];
        expect(createdImage?.src).toBe('blob:image');
        createdImage?.onload?.();

        await expect(decodePromise).resolves.toBe(createdImage);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');
    });

    it('revokes the object URL when fallback image decoding fails', async () => {
        const revokeObjectURL = vi.fn();
        const createdImages: FakeImage[] = [];

        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            src = '';

            constructor() {
                createdImages.push(this);
            }
        }

        vi.stubGlobal('createImageBitmap', undefined);
        vi.stubGlobal('document', {});
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:image'),
            revokeObjectURL,
        });
        vi.stubGlobal('Image', FakeImage);

        const decodePromise = decodeBrowserImageBlob(new Blob(['image']), { fallbackErrorMessage: 'fallback failed' });
        const createdImage = createdImages[0];
        createdImage?.onerror?.();

        await expect(decodePromise).rejects.toThrow('fallback failed');
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');
    });

    it('reports unsupported runtimes before using the object URL fallback', async () => {
        vi.stubGlobal('createImageBitmap', undefined);
        vi.stubGlobal('document', undefined);
        vi.stubGlobal('URL', undefined);
        vi.stubGlobal('Image', undefined);

        await expect(decodeBrowserImageBlob(new Blob(['image']), { fallbackErrorMessage: 'fallback failed' }))
            .rejects.toThrow('Image decoding is unavailable in the current runtime');
    });
});
