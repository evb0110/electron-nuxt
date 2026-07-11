import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {appendPdfImagePage} from '@app/platform/browser-api/appendPdfImagePage';

describe('appendPdfImagePage', () => {
    it('uses image density for physical page dimensions', () => {
        const drawImage = vi.fn();
        const addPage = vi.fn(() => ({drawImage}));
        appendPdfImagePage(
            {addPage} as never,
            {
                width: 1200,
                height: 600,
            } as never,
            {dpi: 300},
        );

        expect(addPage).toHaveBeenCalledWith([
            288,
            144,
        ]);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            width: 288,
            height: 144,
        }));
    });

    it.each([
        [
            3,
            [
                288,
                144,
            ],
        ],
        [
            6,
            [
                144,
                288,
            ],
        ],
        [
            8,
            [
                144,
                288,
            ],
        ],
    ] as const)('applies EXIF orientation %i to the page geometry', (orientation, expectedSize) => {
        const drawImage = vi.fn();
        const addPage = vi.fn(() => ({drawImage}));
        appendPdfImagePage(
            {addPage} as never,
            {
                width: 1200,
                height: 600,
            } as never,
            {
                dpi: 300,
                orientation,
            },
        );

        expect(addPage).toHaveBeenCalledWith(expectedSize);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({rotate: expect.anything()}));
    });
});
