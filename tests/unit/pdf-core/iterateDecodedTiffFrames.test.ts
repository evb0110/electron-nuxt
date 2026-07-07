import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { iterateDecodedTiffFrames } from '@pdf-core/iterateDecodedTiffFrames';

const utifMock = vi.hoisted(() => ({
    decode: vi.fn(),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(),
}));

vi.mock('utif', () => {
    const decode = (...args: unknown[]) => utifMock.decode(...args);
    const decodeImage = (...args: unknown[]) => utifMock.decodeImage(...args);
    const toRGBA8 = (...args: unknown[]) => utifMock.toRGBA8(...args);
    return {
        decode,
        decodeImage,
        toRGBA8,
        default: {
            decode,
            decodeImage,
            toRGBA8,
        },
    };
});

describe('iterateDecodedTiffFrames', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockImplementation(() => undefined);
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
    });

    it('yields decoded RGBA frames within the configured limits', () => {
        const frame = {
            width: 2,
            height: 3,
        };
        const rgba = new Uint8Array(2 * 3 * 4).fill(255);
        utifMock.decode.mockReturnValue([frame]);
        utifMock.toRGBA8.mockReturnValue(rgba);

        expect([...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxFrames: 1,
            maxPixels: 6,
            sourceLabel: 'scan.tif',
        })]).toEqual([{
            frame,
            width: 2,
            height: 3,
            rgba,
        }]);
    });

    it('rejects oversized frame counts before decoding image data', () => {
        utifMock.decode.mockReturnValue([
            {},
            {},
        ]);

        expect(() => [...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxFrames: 1,
            sourceLabel: 'scan.tif',
        })]).toThrow('TIFF frame count is capped at 1: scan.tif');
        expect(utifMock.decodeImage).not.toHaveBeenCalled();
        expect(utifMock.toRGBA8).not.toHaveBeenCalled();
    });

    it('rejects oversized decoded dimensions before allocating RGBA output', () => {
        const frame = {};
        utifMock.decode.mockReturnValue([frame]);
        utifMock.decodeImage.mockImplementation(() => {
            Object.assign(frame, {
                width: 10_000,
                height: 10_000,
            });
        });

        expect(() => [...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxPixels: 80_000_000,
            sourceLabel: 'huge.tif',
        })]).toThrow('TIFF frame dimensions are too large to decode safely: huge.tif');
        expect(utifMock.toRGBA8).not.toHaveBeenCalled();
    });
});
