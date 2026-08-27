import {
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    OCR_SHARD_SIZE,
    decodeOcrShardIndex,
    encodeOcrShardIndex,
    parseOcrCatalogRootV4,
    parseOcrGenerationV4,
    parseOcrShardV4,
    parseOcrShardIndexHeader,
} from '@contracts/ocrIndex';

const revision = requireDocumentRevisionToken('drt1:ocr-index-v4-test');
const catalogId = '123e4567-e89b-42d3-a456-426614174000';

const root = {
    version: 4 as const,
    catalogId,
    source: {pdfPath: '/tmp/document.pdf'},
    documentRevision: {token: revision},
    pageCount: 257,
    shardSize: OCR_SHARD_SIZE,
    generation: 4,
    publishedAt: '2026-08-27T00:00:00.000Z',
};

describe('OCR catalog v4 codecs', () => {
    it('strictly decodes the root and generation manifests', () => {
        expect(parseOcrCatalogRootV4(root)).toEqual(root);
        expect(parseOcrCatalogRootV4({
            ...root,
            catalogId: 'not-a-uuid',
        })).toBeNull();
        const generation = {
            version: 4 as const,
            catalogId,
            generation: 4,
            parent: 3,
            source: root.source,
            documentRevision: root.documentRevision,
            pageCount: 257,
            shardSize: OCR_SHARD_SIZE,
            shardCount: 2,
            mappedPageCount: 1,
            createdAt: root.publishedAt,
            dirtyShards: [0],
            liveRefs: {
                '0': 0,
                '4': 1,
            },
            releasedGenerations: [2],
            releasedLegacyPaths: ['old/page.json'],
        };
        expect(parseOcrGenerationV4(generation, root)).toEqual(generation);
        expect(parseOcrGenerationV4({
            ...generation,
            parent: 4,
        }, root)).toBeNull();
        expect(parseOcrGenerationV4({
            ...generation,
            dirtyShards: [2],
        }, root)).toBeNull();
    });

    it('encodes and validates fixed-width shard index bytes', () => {
        const bytes = encodeOcrShardIndex([
            {
                generation: 4,
                mappedCount: 1,
                reserved: 0,
            },
            {
                generation: 0,
                mappedCount: 0,
                reserved: 0,
            },
        ]);
        expect(bytes.byteLength).toBe(32);
        expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('EVBOIDX4');
        expect(parseOcrShardIndexHeader(bytes)).toEqual({
            shardSize: 256,
            shardCount: 2,
        });
        expect(decodeOcrShardIndex(bytes, {
            expectedPageCount: 257,
            maxGeneration: 4,
        })).toMatchObject({
            shardCount: 2,
            records: [
                {
                    generation: 4,
                    mappedCount: 1,
                    reserved: 0,
                },
                {
                    generation: 0,
                    mappedCount: 0,
                    reserved: 0,
                },
            ],
        });
        expect(decodeOcrShardIndex(bytes.subarray(0, bytes.byteLength - 1))).toBeNull();
        const badReserved = bytes.slice();
        badReserved[23] = 1;
        expect(decodeOcrShardIndex(badReserved)).toBeNull();
        const badGeneration = bytes.slice();
        badGeneration[16] = 5;
        expect(decodeOcrShardIndex(badGeneration, {maxGeneration: 4})).toBeNull();
    });

    it('rejects mappings outside their shard and generation range', () => {
        const validShard = {
            version: 4 as const,
            generation: 4,
            shard: 0,
            pages: {'1': {
                path: 'gen-00000004/pages/000000/p00000001.json',
                generation: 4,
            }},
        };
        expect(parseOcrShardV4(validShard, {
            expectedGeneration: 4,
            expectedShard: 0,
            expectedMappedCount: 1,
            pageCount: 257,
            maxGeneration: 4,
        })).toEqual(validShard);
        expect(parseOcrShardV4({
            ...validShard,
            pages: {'257': validShard.pages['1']},
        }, {
            expectedShard: 0,
            pageCount: 257,
        })).toBeNull();
        expect(parseOcrShardV4({
            ...validShard,
            pages: {'1': {
                ...validShard.pages['1'],
                generation: 5,
            }},
        }, {maxGeneration: 4})).toBeNull();
    });
});
