import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    open: vi.fn(),
    runNativeToolCommand: vi.fn(),
    stat: vi.fn(),
    loadSearchIndex: vi.fn(),
    resolveNativeToolPath: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    open: mocks.open,
    stat: mocks.stat,
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: (...args: unknown[]) => mocks.resolveNativeToolPath(...args)}));

vi.mock('@electron/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 6,
    loadSearchIndex: (...args: unknown[]) => mocks.loadSearchIndex(...args),
}));

function createNativeSearchHeader() {
    const header = Buffer.alloc(24);
    header.write('EVBSIDX1', 0, 'ascii');
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(1, 12);
    header.writeUInt32LE(1, 16);
    return header;
}

describe('native search invocation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_PDF_SEARCH_ENABLE', '1');
        vi.stubEnv('EVB_PDF_SEARCH_TIMEOUT_MS', '30000');
        vi.stubEnv('EVB_PDF_SEARCH_MAX_STDOUT_BYTES', '4194304');
        mocks.resolveNativeToolPath.mockReturnValue('/native/evb-pdf-search');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/doc.pdf') {
                return {mtimeMs: 100};
            }
            if (path === '/tmp/doc.pdf.index.evb-search-v1.bin') {
                return {mtimeMs: 200};
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });
        mocks.open.mockResolvedValue({
            read: vi.fn(async (buffer: Buffer) => {
                createNativeSearchHeader().copy(buffer);
                return {bytesRead: 24};
            }),
            stat: vi.fn(async () => ({size: 48})),
            close: vi.fn(async () => undefined),
        });
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 6,
            pdfPath: '/tmp/doc.pdf',
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'needle',
                words: [{
                    text: 'needle',
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                }],
                pageWidth: 100,
                pageHeight: 100,
            }],
        });
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                pageCount: 1,
                results: [],
                truncated: false,
            }),
            stderr: '',
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('runs native search with bounded stdout and truncation rejection', async () => {
        const controller = new AbortController();
        const { tryRunNativeSearch } = await import('@electron/search/nativeSearch');

        await expect(tryRunNativeSearch({
            pdfPath: '/tmp/doc.pdf',
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pageCount: 1,
            signal: controller.signal,
        })).resolves.toMatchObject({
            response: {
                results: [],
                truncated: false,
            },
            totalPages: 1,
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-search',
            [
                'search',
                '--index',
                '/tmp/doc.pdf.index.evb-search-v1.bin',
                '--query',
                'needle',
                '--limit',
                '500',
                '--context',
                '56',
                '--page-count',
                '1',
            ],
            {
                timeoutMs: 30000,
                maxStdoutBytes: 4 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
                commandLabel: 'evb-pdf-search(search)',
                signal: controller.signal,
            },
        );
    });
});
