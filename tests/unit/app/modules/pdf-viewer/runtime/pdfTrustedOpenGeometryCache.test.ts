// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import { requireEpochMs } from '@contracts/timestamps';
import {
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
} from 'vitest';
import {
    cacheTrustedPdfOpenGeometry,
    isTrustedPdfOpenGeometryCurrent,
    invalidateTrustedPdfOpenGeometry,
    peekTrustedPdfOpenGeometry,
    prevalidateTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
    rememberValidatedTrustedPdfOpenGeometry,
    type IPdfTrustedOpenGeometry,
    writeTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';

const entry: IPdfTrustedOpenGeometry = {
    documentId: '/documents/scan.pdf',
    size: 28_000_000,
    modifiedAt: 1_750_000_000_000,
    pageNumber: requirePageNumber(7),
    pageCount: 431,
    width: 612,
    height: 792,
    rotation: 0,
    savedAt: 1_750_000_001_000,
};

expectTypeOf<IPdfTrustedOpenGeometry>().toMatchTypeOf<{
    size: number;
    modifiedAt: number;
}>();

describe('trusted PDF open geometry cache', () => {
    beforeEach(() => {
        localStorage.clear();
        invalidateTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1));
        invalidateTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber);
    });

    it('makes only fingerprint-validated warm geometry synchronously available to open intent', async () => {
        writeTrustedPdfOpenGeometry(entry);

        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber)).toBeNull();
        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            entry.pageNumber,
            async () => ({
                size: entry.size,
                modifiedAt: entry.modifiedAt,
            }),
        )).resolves.toEqual(entry);
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber)).toEqual(entry);
    });

    it('deduplicates concurrent source-stat validation', async () => {
        writeTrustedPdfOpenGeometry(entry);
        let readCount = 0;
        const readStat = async () => {
            readCount += 1;
            return {
                size: entry.size,
                modifiedAt: entry.modifiedAt,
            };
        };

        await Promise.all([
            prevalidateTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber, readStat),
            prevalidateTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber, readStat),
        ]);
        expect(readCount).toBe(1);
    });

    it('creates a validated warm entry from fenced first-page metadata on cache miss', async () => {
        const openingGeometry = {
            pageNumber: requirePageNumber(1),
            pageCount: entry.pageCount,
            width: entry.width,
            height: entry.height,
            rotation: 0 as const,
            size: entry.size,
            modifiedAt: requireEpochMs(entry.modifiedAt),
        };

        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            requirePageNumber(1),
            async () => {
                throw new Error('stat is unnecessary on a cache miss');
            },
            async () => openingGeometry,
        )).resolves.toMatchObject({
            documentId: entry.documentId,
            ...openingGeometry,
        });
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toMatchObject(openingGeometry);
    });

    it('uses admitted dimensions with the original source revision', () => {
        const cached = cacheTrustedPdfOpenGeometry(entry.documentId, {
            pageNumber: requirePageNumber(1),
            pageCount: 8,
            width: 640,
            height: 900,
            rotation: 0,
            size: 20,
            modifiedAt: requireEpochMs(30),
        }, {sourceRevision: {
            size: entry.size,
            modifiedAt: entry.modifiedAt,
        }});

        expect(cached).toMatchObject({
            documentId: entry.documentId,
            pageCount: 8,
            width: 640,
            height: 900,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
        });
        invalidateTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1));
    });

    it('keeps geometry without an original revision out of synchronous open reuse', () => {
        cacheTrustedPdfOpenGeometry(entry.documentId, {
            pageNumber: requirePageNumber(1),
            pageCount: 8,
            width: 640,
            height: 900,
            rotation: 0,
            size: 20,
            modifiedAt: requireEpochMs(30),
        }, {makeSynchronouslyAvailable: false});

        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toBeNull();
        expect(peekTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toMatchObject({
            size: 20,
            modifiedAt: 30,
        });
        invalidateTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1));
    });

    it('replaces a persistent entry through fenced geometry when direct source stat is unavailable', async () => {
        const staleEntry = {
            ...entry,
            pageNumber: requirePageNumber(1),
        };
        const openingGeometry = {
            pageNumber: requirePageNumber(1),
            pageCount: entry.pageCount,
            width: entry.width,
            height: entry.height,
            rotation: 0 as const,
            size: entry.size + 1,
            modifiedAt: requireEpochMs(entry.modifiedAt + 1),
        };
        writeTrustedPdfOpenGeometry(staleEntry);

        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            requirePageNumber(1),
            async () => {
                throw new Error('original source stat is not a managed read');
            },
            async () => openingGeometry,
        )).resolves.toMatchObject(openingGeometry);
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toMatchObject(openingGeometry);
        expect(peekTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toMatchObject(openingGeometry);
    });

    it('rejects and removes a stale preflight entry', async () => {
        writeTrustedPdfOpenGeometry(entry);
        rememberValidatedTrustedPdfOpenGeometry(entry);
        invalidateTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber);
        writeTrustedPdfOpenGeometry(entry);

        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            entry.pageNumber,
            async () => ({
                size: entry.size + 1,
                modifiedAt: entry.modifiedAt,
            }),
        )).resolves.toBeNull();
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber)).toBeNull();
        expect(peekTrustedPdfOpenGeometry(entry.documentId, entry.pageNumber)).toBeNull();
    });

    it('exposes an unvalidated entry only for presence checks and invalidation', () => {
        writeTrustedPdfOpenGeometry(entry);

        expect(peekTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(7))).toEqual(entry);
        expect(peekTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(1))).toBeNull();

        invalidateTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(7));
        expect(peekTrustedPdfOpenGeometry(entry.documentId, requirePageNumber(7))).toBeNull();
    });
    it('accepts geometry only for the exact source revision', () => {
        expect(isTrustedPdfOpenGeometryCurrent(entry, entry.documentId, {
            size: entry.size,
            modifiedAt: entry.modifiedAt,
        }, entry.pageNumber)).toBe(true);
    });

    it.each([
        [
            '/documents/other.pdf',
            entry.size,
            entry.modifiedAt,
        ],
        [
            entry.documentId,
            entry.size + 1,
            entry.modifiedAt,
        ],
        [
            entry.documentId,
            entry.size,
            entry.modifiedAt + 1,
        ],
        [
            entry.documentId,
            entry.size,
            undefined,
        ],
    ])('rejects a stale or unverifiable source (%s, %s, %s)', (documentId, size, modifiedAt) => {
        expect(isTrustedPdfOpenGeometryCurrent(entry, documentId, {
            size,
            ...(modifiedAt === undefined ? {} : {modifiedAt}),
        })).toBe(false);
    });

    it('never reuses another page geometry from a heterogeneous document', () => {
        expect(isTrustedPdfOpenGeometryCurrent(entry, entry.documentId, {
            size: entry.size,
            modifiedAt: entry.modifiedAt,
        }, requirePageNumber(entry.pageNumber + 1))).toBe(false);
    });

    it('keeps a mixed-page document seed provisional so every page is authoritatively replaced', () => {
        const seed = buildTrustedPdfGeometrySeed({
            pageNumber: requirePageNumber(7),
            pageCount: 431,
            width: 612,
            height: 792,
        });
        expect(seed).toEqual({
            numPages: 431,
            basePageWidth: 612,
            basePageHeight: 792,
            pageMetrics: [],
        });
    });
});
