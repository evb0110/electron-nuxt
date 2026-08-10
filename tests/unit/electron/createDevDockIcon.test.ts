import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createDevDockIcon } from '@electron/bootstrap/createDevDockIcon';

const mocks = vi.hoisted(() => ({
    createFromBitmap: vi.fn(),
    createFromPath: vi.fn(),
}));

vi.mock('electron', () => ({nativeImage: {
    createFromBitmap: (...args: unknown[]) => mocks.createFromBitmap(...args),
    createFromPath: (...args: unknown[]) => mocks.createFromPath(...args),
}}));

describe('createDevDockIcon', () => {
    it('treats Electron 43 sRGB-normalized bitmap output as the source image', () => {
        const width = 256;
        const height = 256;
        const normalizedBitmap = Buffer.alloc(width * height * 4);
        for (let offset = 0; offset < normalizedBitmap.length; offset += 4) {
            normalizedBitmap[offset] = (offset / 4) % 251;
            normalizedBitmap[offset + 1] = 73;
            normalizedBitmap[offset + 2] = 149;
            normalizedBitmap[offset + 3] = 201;
        }
        const outputImage = {isEmpty: () => false};
        mocks.createFromPath.mockReturnValue({
            getSize: () => ({
                width,
                height,
            }),
            isEmpty: () => false,
            toBitmap: () => Buffer.from(normalizedBitmap),
        });
        mocks.createFromBitmap.mockReturnValue(outputImage);

        expect(createDevDockIcon('/tmp/dev-icon.png')).toBe(outputImage);

        expect(mocks.createFromBitmap).toHaveBeenCalledOnce();
        const [
            outputBitmap,
            options,
        ] = mocks.createFromBitmap.mock.calls[0]!;
        expect(options).toEqual({
            width,
            height,
        });
        expect(outputBitmap).toBeInstanceOf(Buffer);
        const outputBytes = outputBitmap as Buffer;
        expect(outputBytes).toHaveLength(normalizedBitmap.length);
        expect(outputBytes.subarray(0, 4)).toEqual(normalizedBitmap.subarray(0, 4));
        expect(outputBytes.equals(normalizedBitmap)).toBe(false);
        expect(outputBytes.some((byte, index) => byte !== normalizedBitmap[index])).toBe(true);
    });
});
