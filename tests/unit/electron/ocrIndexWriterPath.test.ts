import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean }>>(),
    readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
    realpath: vi.fn<(path: string) => Promise<string>>(),
    writeFile: vi.fn<(path: string, data: string, encoding: string) => Promise<void>>(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('fs/promises', () => ({
    lstat: (path: string) => mocks.lstat(path),
    readFile: (path: string, encoding: string) => mocks.readFile(path, encoding),
    realpath: (path: string) => mocks.realpath(path),
    mkdir: vi.fn(),
    rename: vi.fn(),
    writeFile: (path: string, data: string, encoding: string) => mocks.writeFile(path, data, encoding),
}));

const {
    resolveSafeOcrIndexBasePath,
    writeOcrIndexV2,
} = await import('@electron/ocr/worker/indexWriter');

describe('resolveSafeOcrIndexBasePath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.lstat.mockResolvedValue(createStat(false));
        mocks.realpath.mockImplementation(async (path: string) => path);
    });

    it('accepts existing non-symlink targets inside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/tmp/work.pdf');
    });

    it('rejects targets outside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/Users/alice/work.pdf', '/tmp')).rejects.toThrow(
            'outside the allowed temp directory',
        );
    });

    it('rejects symlink targets', async () => {
        mocks.lstat.mockResolvedValue(createStat(true));

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).rejects.toThrow(
            'cannot be a symbolic link',
        );
    });

    it('accepts canonicalized temp paths', async () => {
        mocks.realpath.mockImplementation(async (path: string) => {
            if (path === '/tmp') {
                return '/private/tmp';
            }
            if (path === '/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            if (path === '/private/tmp') {
                return '/private/tmp';
            }
            if (path === '/private/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            return path;
        });

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/private/tmp/work.pdf');
    });
});

describe('writeOcrIndexV2', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.writeFile.mockResolvedValue();
    });

    it('preserves existing page mappings when writing a partial OCR run', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 2,
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: { path: 'page-0001.json' }},
        }));

        await writeOcrIndexV2('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [{
                text: 'page',
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path === '/tmp/work.pdf.ocr/manifest.json.tmp');
        expect(manifestWrite).toBeTruthy();
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({
            1: { path: 'page-0001.json' },
            2: { path: 'page-0002.json' },
        });
    });

    it('drops preserved page mappings when the existing manifest belongs to a different page set', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify({
            version: 2,
            createdAt: 1,
            source: { pdfPath: '/tmp/work.pdf' },
            pageCount: 3,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: { path: 'page-0001.json' },
                3: { path: 'page-0003.json' },
            },
        }));

        await writeOcrIndexV2('/tmp/work.pdf', [{
            pageNumber: 2,
            text: 'page two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const manifestWrite = mocks.writeFile.mock.calls.find(([path]) => path === '/tmp/work.pdf.ocr/manifest.json.tmp');
        expect(manifestWrite).toBeTruthy();
        const manifest = JSON.parse(manifestWrite?.[1] ?? '{}') as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({2: { path: 'page-0002.json' }});
    });
});
