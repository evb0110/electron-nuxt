import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as PdfCoreModule from '@pdf-core';

const mocks = vi.hoisted(() => {
    const nativeCombine = vi.fn();
    let headerPrefix: Uint8Array = new Uint8Array();
    const openFileClose = vi.fn();
    const openFileRead = vi.fn(async (buffer: Uint8Array) => {
        buffer.set(headerPrefix);
        return { bytesRead: headerPrefix.byteLength };
    });
    const open = vi.fn(async () => ({
        read: openFileRead,
        close: openFileClose,
    }));
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));
    const drawImage = vi.fn();
    const addPage = vi.fn(() => ({drawImage}));
    const embedPng = vi.fn(async () => ({
        width: 10,
        height: 20,
    }));
    const save = vi.fn<() => Promise<{byteLength: number}>>(async () => new Uint8Array([
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        embedPng,
        embedJpg: vi.fn(),
        save,
    }));
    const nativeImageToPng = vi.fn(() => new Uint8Array([
        8,
        8,
    ]));
    const nativeImageIsEmpty = vi.fn(() => false);
    const nativeImageCreateFromPath = vi.fn(() => ({
        isEmpty: nativeImageIsEmpty,
        toPNG: nativeImageToPng,
    }));

    return {
        nativeCombine,
        get headerPrefix() {
            return headerPrefix;
        },
        set headerPrefix(value: Uint8Array) {
            headerPrefix = value;
        },
        open,
        openFileClose,
        openFileRead,
        readFile,
        stat,
        drawImage,
        addPage,
        embedPng,
        save,
        create,
        nativeImageCreateFromPath,
        nativeImageIsEmpty,
        nativeImageToPng,
    };
});

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({tryCreatePdfWithNativeImageCombiner: mocks.nativeCombine}));

vi.mock('fs/promises', () => ({
    open: mocks.open,
    readFile: mocks.readFile,
    stat: mocks.stat,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {create: mocks.create}}));

vi.mock('@pdf-core', async (importOriginal) => {
    const actual = await importOriginal<typeof PdfCoreModule>();
    return {
        ...actual,
        applyCombinedPdfPageLabels: vi.fn(),
        writePdfBookmarkOutlines: vi.fn(),
    };
});

vi.mock('electron', () => ({nativeImage: {createFromPath: mocks.nativeImageCreateFromPath}}));

const { createCombinedPdf } = await import('@electron/image/pdfCombineShared');

describe('createCombinedPdf native image fast path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.nativeCombine.mockResolvedValue(null);
        mocks.headerPrefix = new Uint8Array();
        mocks.readFile.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
        mocks.save.mockResolvedValue(new Uint8Array([
            9,
            9,
        ]));
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

    it('rejects oversized JS fallback inputs before reading them', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 513 * 1024 * 1024,
        });

        await expect(createCombinedPdf(['/tmp/huge.png'], {unsupportedFileError: sourcePath => `Unsupported: ${sourcePath}`}))
            .rejects
            .toThrow('Input file is too large to combine safely: /tmp/huge.png');

        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
    });

    it('checks PNG dimensions before embedding the image into pdf-lib', async () => {
        mocks.readFile.mockResolvedValueOnce(createPngHeader(10_000, 10_000));

        await expect(createCombinedPdf(['/tmp/oversized.png'], {unsupportedFileError: sourcePath => `Unsupported: ${sourcePath}`}))
            .rejects
            .toThrow('Image dimensions are too large to combine safely: /tmp/oversized.png');

        expect(mocks.embedPng).not.toHaveBeenCalled();
        expect(mocks.addPage).not.toHaveBeenCalled();
    });

    it('rejects oversized JS fallback output before returning it', async () => {
        mocks.save.mockResolvedValueOnce({byteLength: 513 * 1024 * 1024});

        await expect(createCombinedPdf(['/tmp/a.png'], {unsupportedFileError: sourcePath => `Unsupported: ${sourcePath}`}))
            .rejects
            .toThrow('Combined PDF output is too large to return safely');
    });

    it.each([
        [
            'BMP',
            '/tmp/oversized.bmp',
            createBmpHeader(10_000, 10_000),
        ],
        [
            'GIF',
            '/tmp/oversized.gif',
            createGifHeader(10_000, 10_000),
        ],
        [
            'WEBP',
            '/tmp/oversized.webp',
            createWebpExtendedHeader(10_000, 10_000),
        ],
    ])('rejects oversized %s dimensions before Electron decodes the image', async (_format, sourcePath, header) => {
        mocks.headerPrefix = header;

        await expect(createCombinedPdf([sourcePath], {unsupportedFileError: path => `Unsupported: ${path}`}))
            .rejects
            .toThrow(`Image dimensions are too large to combine safely: ${sourcePath}`);

        expect(mocks.open).toHaveBeenCalledWith(sourcePath, 'r');
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.nativeImageCreateFromPath).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
        expect(mocks.addPage).not.toHaveBeenCalled();
    });

    it.each([
        [
            'BMP',
            '/tmp/small.bmp',
            createBmpCoreHeader(10, 20),
        ],
        [
            'GIF',
            '/tmp/small.gif',
            createGifHeader(10, 20),
        ],
        [
            'WEBP',
            '/tmp/small.webp',
            createWebpExtendedHeader(10, 20),
        ],
    ])('combines a small valid %s image after the header preflight', async (_format, sourcePath, header) => {
        mocks.headerPrefix = header;

        const result = await createCombinedPdf([sourcePath], {unsupportedFileError: path => `Unsupported: ${path}`});

        expect(Array.from(result)).toEqual([
            9,
            9,
        ]);
        expect(mocks.nativeImageCreateFromPath).toHaveBeenCalledWith(sourcePath);
        expect(mocks.nativeImageToPng).toHaveBeenCalledTimes(1);
        expect(mocks.embedPng).toHaveBeenCalledWith(new Uint8Array([
            8,
            8,
        ]));
        expect(mocks.addPage).toHaveBeenCalledWith([
            10,
            20,
        ]);
    });

    it.each([
        [
            'BMP',
            '/tmp/unparseable.bmp',
            new Uint8Array([
                0x42,
                0x4d,
            ]),
        ],
        [
            'GIF',
            '/tmp/unparseable.gif',
            new Uint8Array([
                0x47,
                0x49,
                0x46,
            ]),
        ],
        [
            'WEBP',
            '/tmp/unparseable.webp',
            new Uint8Array([
                0x52,
                0x49,
                0x46,
                0x46,
            ]),
        ],
    ])('fails closed for an unparseable %s header before Electron decodes the image', async (_format, sourcePath, header) => {
        mocks.headerPrefix = header;

        await expect(createCombinedPdf([sourcePath], {unsupportedFileError: path => `Unsupported: ${path}`}))
            .rejects
            .toThrow(`Image dimensions are too large to combine safely: ${sourcePath}`);

        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.nativeImageCreateFromPath).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
    });
});

function createPngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(24));
    data.set([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52,
    ]);
    data[16] = (width >>> 24) & 0xff;
    data[17] = (width >>> 16) & 0xff;
    data[18] = (width >>> 8) & 0xff;
    data[19] = width & 0xff;
    data[20] = (height >>> 24) & 0xff;
    data[21] = (height >>> 16) & 0xff;
    data[22] = (height >>> 8) & 0xff;
    data[23] = height & 0xff;
    return data;
}

function writeUint16LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
}

function writeInt32LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
    data[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint24LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
}

function createBmpHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(26));
    data[0] = 0x42;
    data[1] = 0x4d;
    writeInt32LE(data, 14, 40);
    writeInt32LE(data, 18, width);
    writeInt32LE(data, 22, height);
    return data;
}

function createBmpCoreHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(22));
    data[0] = 0x42;
    data[1] = 0x4d;
    writeInt32LE(data, 14, 12);
    writeUint16LE(data, 18, width);
    writeUint16LE(data, 20, height);
    return data;
}

function createGifHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(10));
    data.set([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61,
    ]);
    writeUint16LE(data, 6, width);
    writeUint16LE(data, 8, height);
    return data;
}

function createWebpExtendedHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(30));
    data.set([
        0x52,
        0x49,
        0x46,
        0x46,
        0x16,
        0x00,
        0x00,
        0x00,
        0x57,
        0x45,
        0x42,
        0x50,
        0x56,
        0x50,
        0x38,
        0x58,
        0x0a,
        0x00,
        0x00,
        0x00,
    ]);
    writeUint24LE(data, 24, width - 1);
    writeUint24LE(data, 27, height - 1);
    return data;
}
