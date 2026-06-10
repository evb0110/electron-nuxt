import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    getCompactSearchIndexPath,
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import { OCR_TEXT_LAYER_INDEX_VERSION } from '@contracts/ocrText';

describe('compact search index sidecar', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-search-sidecar-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('writes the native-search-compatible header, records, and UTF-8 page text', async () => {
        const pdfPath = join(tempDir, 'work.pdf');

        await persistCompactSearchIndex(pdfPath, {
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 2,
                    text: 'second page',
                },
                {
                    pageNumber: 1,
                    text: 'first page',
                },
            ],
        });

        const sidecar = await readFile(getCompactSearchIndexPath(pdfPath));
        expect(sidecar.toString('ascii', 0, 8)).toBe(COMPACT_SEARCH_INDEX_MAGIC);
        expect(sidecar.readUInt32LE(8)).toBe(COMPACT_SEARCH_INDEX_SCHEMA_VERSION);
        expect(sidecar.readUInt32LE(12)).toBe(2);
        expect(sidecar.readUInt32LE(16)).toBe(2);
        expect(sidecar.readUInt32LE(20)).toBe(
            COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER + OCR_TEXT_LAYER_INDEX_VERSION * 0x10000,
        );

        const firstRecordOffset = COMPACT_SEARCH_INDEX_HEADER_SIZE;
        expect(sidecar.readUInt32LE(firstRecordOffset)).toBe(1);
        expect(sidecar.readUInt32LE(firstRecordOffset + COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE)).toBe(2);

        const loaded = await loadCompactSearchIndex(pdfPath, { expectedPageCount: 2 });
        expect(loaded).toEqual({
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'first page',
                },
                {
                    pageNumber: 2,
                    text: 'second page',
                },
            ],
        });
    });

    it('rejects stale sidecars when the source mtime is newer', async () => {
        const pdfPath = join(tempDir, 'work.pdf');
        await persistCompactSearchIndex(pdfPath, {
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'current text',
            }],
        });

        const sidecarStat = await stat(getCompactSearchIndexPath(pdfPath));

        await expect(loadCompactSearchIndex(pdfPath, {
            expectedPageCount: 1,
            minSourceMtimeMs: sidecarStat.mtimeMs + 1000,
        })).resolves.toBeNull();

        await expect(loadCompactSearchIndex(pdfPath, {
            expectedPageCount: 1,
            minSourceMtimeMs: sidecarStat.mtimeMs,
        })).resolves.toEqual({
            pageCount: 1,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
                version: 0,
            },
            pages: [{
                pageNumber: 1,
                text: 'current text',
            }],
        });
    });

    it('requires expected page coverage before loading', async () => {
        const pdfPath = join(tempDir, 'partial.pdf');
        await persistCompactSearchIndex(pdfPath, {
            pageCount: 3,
            pages: [{
                pageNumber: 1,
                text: 'partial text',
            }],
        });

        await expect(loadCompactSearchIndex(pdfPath, { expectedPageCount: 3 })).resolves.toBeNull();
        await expect(loadCompactSearchIndex(pdfPath, { expectedPageCount: 1 })).resolves.toEqual({
            pageCount: 3,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
                version: 0,
            },
            pages: [{
                pageNumber: 1,
                text: 'partial text',
            }],
        });
    });

    it('rejects sidecars that do not match the required text source', async () => {
        const pdfPath = join(tempDir, 'generic.pdf');
        await persistCompactSearchIndex(pdfPath, {
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'generic text',
            }],
        });

        await expect(loadCompactSearchIndex(pdfPath, {
            expectedPageCount: 1,
            requiredTextSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
        })).resolves.toBeNull();
    });
});
