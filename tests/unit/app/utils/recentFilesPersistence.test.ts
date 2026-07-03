import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    parseRecentFilesCookieSnapshot,
    readBrowserRecentFilesSnapshot,
    serializeRecentFilesCookiePayload,
    trimRecentFilesForCookie,
} from '@app/utils/recentFilesPersistence';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

function stubBrowserStorage(options: {
    cookie?: string;
    storage?: Record<string, string>;
}) {
    const storage = options.storage ?? {};
    vi.stubGlobal('document', {cookie: options.cookie ?? ''});
    vi.stubGlobal('window', {localStorage: {getItem: (key: string) => storage[key] ?? null}});
}

describe('recentFilesPersistence', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps adding recent files to the cookie payload until the encoded-size limit is reached', () => {
        const recentFiles = Array.from({ length: 12 }, (_, index) => ({
            originalPath: `browser://documents/${index}/doc-${index}.pdf`,
            backend: 'browser' as const,
            fileName: `doc-${index}.pdf`,
            timestamp: index + 1,
            fileSize: 1024,
        }));

        const trimmed = trimRecentFilesForCookie(recentFiles);

        expect(trimmed.recentFiles.length).toBeGreaterThan(8);
        expect(trimmed.recentFiles).toEqual(recentFiles);
        expect(trimmed.truncated).toBe(false);
    });

    it('marks cookie snapshots as truncated when not every recent file fits', () => {
        const recentFiles = Array.from({ length: 30 }, (_, index) => ({
            originalPath: `/Users/example/Desktop/really-long-folder-name-${index}/really-long-folder-name-${index}/document-${index}.pdf`,
            fileName: `really-long-document-name-${index}.pdf`,
            timestamp: index + 1,
            fileSize: 2048,
        }));

        const serialized = serializeRecentFilesCookiePayload(recentFiles);
        const snapshot = parseRecentFilesCookieSnapshot(serialized);

        expect(snapshot.hasSnapshot).toBe(true);
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.recentFiles.length).toBeLessThan(recentFiles.length);
    });

    it('parses the compact cookie snapshot format', () => {
        const snapshot = parseRecentFilesCookieSnapshot(JSON.stringify({
            v: 1,
            t: false,
            f: [[
                '/tmp/example.pdf',
                'example.pdf',
                123,
                456,
            ]],
        }));

        expect(snapshot).toEqual({
            recentFiles: [{
                originalPath: '/tmp/example.pdf',
                backend: 'electron',
                fileName: 'example.pdf',
                timestamp: 123,
                fileSize: 456,
            }],
            hasSnapshot: true,
            truncated: false,
        });
    });

    it('keeps only the newest entry for each recent file path', () => {
        const snapshot = parseRecentFilesCookieSnapshot(JSON.stringify({
            v: 1,
            t: false,
            f: [
                [
                    '/tmp/example.pdf',
                    'example-new.pdf',
                    3,
                    456,
                ],
                [
                    '/tmp/other.pdf',
                    'other.pdf',
                    2,
                    123,
                ],
                [
                    '/tmp/example.pdf',
                    'example-old.pdf',
                    1,
                    456,
                ],
            ],
        }));

        expect(snapshot.recentFiles).toEqual([
            {
                originalPath: '/tmp/example.pdf',
                backend: 'electron',
                fileName: 'example-new.pdf',
                timestamp: 3,
                fileSize: 456,
            },
            {
                originalPath: '/tmp/other.pdf',
                backend: 'electron',
                fileName: 'other.pdf',
                timestamp: 2,
                fileSize: 123,
            },
        ]);
    });

    it('reads a complete browser cookie snapshot synchronously', () => {
        const payload = serializeRecentFilesCookiePayload([{
            originalPath: 'browser://documents/cookie',
            fileName: 'cookie.pdf',
            timestamp: 1,
            fileSize: 2,
        }]);
        stubBrowserStorage({
            cookie: `evb_viewer_recent_files=${encodeURIComponent(payload)}`,
            storage: {[BROWSER_RECENT_FILES_STORAGE_KEY]: JSON.stringify([{
                originalPath: 'browser://documents/storage',
                fileName: 'storage.pdf',
                timestamp: 3,
                fileSize: 4,
            }])},
        });

        expect(readBrowserRecentFilesSnapshot()).toEqual({
            recentFiles: [{
                originalPath: 'browser://documents/cookie',
                backend: 'browser',
                fileName: 'cookie.pdf',
                timestamp: 1,
                fileSize: 2,
            }],
            hasSnapshot: true,
            truncated: false,
        });
    });

    it('falls back to localStorage when the browser cookie snapshot is missing', () => {
        stubBrowserStorage({storage: {[BROWSER_RECENT_FILES_STORAGE_KEY]: JSON.stringify([{
            originalPath: 'browser://documents/storage',
            fileName: 'storage.pdf',
            timestamp: 3,
            fileSize: 4,
        }])}});

        expect(readBrowserRecentFilesSnapshot()).toEqual({
            recentFiles: [{
                originalPath: 'browser://documents/storage',
                backend: 'browser',
                fileName: 'storage.pdf',
                timestamp: 3,
                fileSize: 4,
            }],
            hasSnapshot: true,
            truncated: false,
        });
    });

    it('drops legacy recent files whose backend cannot be inferred', () => {
        const snapshot = parseRecentFilesCookieSnapshot(JSON.stringify({files: [
            {
                originalPath: 'relative.pdf',
                fileName: 'relative.pdf',
                timestamp: 1,
            },
            {
                originalPath: 'browser://documents/known',
                fileName: 'known.pdf',
                timestamp: 2,
            },
        ]}));

        expect(snapshot.recentFiles).toEqual([{
            originalPath: 'browser://documents/known',
            backend: 'browser',
            fileName: 'known.pdf',
            timestamp: 2,
        }]);
    });
});
