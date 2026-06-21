import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const nativeCombine = vi.fn();
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const drawImage = vi.fn();
    const addPage = vi.fn(() => ({drawImage}));
    const embedPng = vi.fn(async () => ({
        width: 10,
        height: 20,
    }));
    const save = vi.fn(async () => new Uint8Array([
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        embedPng,
        embedJpg: vi.fn(),
        save,
    }));

    return {
        nativeCombine,
        readFile,
        drawImage,
        addPage,
        embedPng,
        save,
        create,
    };
});

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({tryCreatePdfWithNativeImageCombiner: mocks.nativeCombine}));

vi.mock('fs/promises', () => ({readFile: mocks.readFile}));

vi.mock('pdf-lib', () => ({PDFDocument: {create: mocks.create}}));

const { createCombinedPdf } = await import('@electron/image/pdfCombineShared');

describe('createCombinedPdf native image fast path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.nativeCombine.mockResolvedValue(null);
    });

    it('returns the native image PDF output without creating a pdf-lib document', async () => {
        const progress = vi.fn();
        mocks.nativeCombine.mockResolvedValue(new Uint8Array([
            7,
            7,
        ]));

        const result = await createCombinedPdf([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], {
            onProgress: progress,
            unsupportedFileError: sourcePath => `Unsupported: ${sourcePath}`,
        });

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.nativeCombine).toHaveBeenCalledWith([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], {onProgress: progress});
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it('falls back to pdf-lib when the native image combiner is unavailable', async () => {
        const result = await createCombinedPdf(['/tmp/a.png'], {unsupportedFileError: sourcePath => `Unsupported: ${sourcePath}`});

        expect(Array.from(result)).toEqual([
            9,
            9,
        ]);
        expect(mocks.nativeCombine).toHaveBeenCalledTimes(1);
        expect(mocks.create).toHaveBeenCalledTimes(1);
        expect(mocks.embedPng).toHaveBeenCalledWith(expect.any(Uint8Array));
        expect(mocks.addPage).toHaveBeenCalledWith([
            10,
            20,
        ]);
        expect(mocks.drawImage).toHaveBeenCalledWith(await mocks.embedPng.mock.results[0]?.value, {
            x: 0,
            y: 0,
            width: 10,
            height: 20,
        });
        expect(mocks.save).toHaveBeenCalledTimes(1);
    });
});
