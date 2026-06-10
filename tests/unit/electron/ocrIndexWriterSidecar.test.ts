import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeOcrIndexV2 } from '@electron/ocr/worker/indexWriter';
import {
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import { OCR_TEXT_LAYER_INDEX_VERSION } from '@contracts/ocrText';

describe('writeOcrIndexV2 compact search sidecar', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-sidecar-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('preserves OCR v2 JSON files while writing compact text-layer search text', async () => {
        const pdfPath = join(tempDir, 'work.pdf');

        await writeOcrIndexV2(pdfPath, [
            {
                pageNumber: 1,
                text: 'raw one',
                imageWidth: 100,
                imageHeight: 200,
                words: [
                    {
                        text: 'alpha',
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                    {
                        text: 'beta',
                        x: 20,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                ],
            },
            {
                pageNumber: 2,
                text: 'raw two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        const manifest = JSON.parse(await readFile(`${pdfPath}.ocr/manifest.json`, 'utf-8')) as { pages: Record<string, { path: string }> };
        expect(manifest.pages).toEqual({
            1: { path: 'page-0001.json' },
            2: { path: 'page-0002.json' },
        });
        await expect(readFile(`${pdfPath}.ocr/page-0001.json`, 'utf-8')).resolves.toContain('"words"');

        const compactIndex = await loadCompactSearchIndex(pdfPath, { expectedPageCount: 2 });
        expect(compactIndex).toEqual({
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'alpha beta \n',
                },
                {
                    pageNumber: 2,
                    text: 'raw two',
                },
            ],
        });
    });

    it('merges a partial OCR rerun into the existing compact sidecar', async () => {
        const pdfPath = join(tempDir, 'partial.pdf');
        await writeOcrIndexV2(pdfPath, [
            {
                pageNumber: 1,
                text: 'original one',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 2,
                text: 'original two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        await writeOcrIndexV2(pdfPath, [{
            pageNumber: 2,
            text: 'updated two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const compactIndex = await loadCompactSearchIndex(pdfPath, { expectedPageCount: 2 });
        expect(compactIndex).toEqual({
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'original one',
                },
                {
                    pageNumber: 2,
                    text: 'updated two',
                },
            ],
        });
    });

    it('ignores generic compact sidecars when preserving partial OCR pages', async () => {
        const pdfPath = join(tempDir, 'generic-collision.pdf');
        await writeOcrIndexV2(pdfPath, [
            {
                pageNumber: 1,
                text: 'authoritative json one',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
            {
                pageNumber: 2,
                text: 'authoritative json two',
                imageWidth: 100,
                imageHeight: 200,
                words: [],
            },
        ], 2, ['eng'], 300, vi.fn());

        await persistCompactSearchIndex(pdfPath, {
            pageCount: 2,
            pages: [
                {
                    pageNumber: 1,
                    text: 'generic sidecar one',
                },
                {
                    pageNumber: 2,
                    text: 'generic sidecar two',
                },
            ],
        });

        await writeOcrIndexV2(pdfPath, [{
            pageNumber: 2,
            text: 'updated json two',
            imageWidth: 100,
            imageHeight: 200,
            words: [],
        }], 2, ['eng'], 300, vi.fn());

        const compactIndex = await loadCompactSearchIndex(pdfPath, { expectedPageCount: 2 });
        expect(compactIndex).toEqual({
            pageCount: 2,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
            pages: [
                {
                    pageNumber: 1,
                    text: 'authoritative json one',
                },
                {
                    pageNumber: 2,
                    text: 'updated json two',
                },
            ],
        });
    });
});
