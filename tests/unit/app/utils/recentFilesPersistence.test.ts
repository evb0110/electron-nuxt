import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseRecentFilesCookieSnapshot,
    serializeRecentFilesCookiePayload,
    trimRecentFilesForCookie,
} from '@app/utils/recent-files-persistence';

describe('recent-files-persistence', () => {
    it('keeps adding recent files to the cookie payload until the encoded-size limit is reached', () => {
        const recentFiles = Array.from({ length: 12 }, (_, index) => ({
            originalPath: `browser://documents/${index}/doc-${index}.pdf`,
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
            originalPath: `.devkit/manual-fixtures/really-long-folder-name-${index}/really-long-folder-name-${index}/document-${index}.pdf`,
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
                fileName: 'example.pdf',
                timestamp: 123,
                fileSize: 456,
            }],
            hasSnapshot: true,
            truncated: false,
        });
    });
});
