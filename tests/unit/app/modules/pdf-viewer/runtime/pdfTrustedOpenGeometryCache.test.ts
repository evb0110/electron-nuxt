// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
} from 'vitest';
import {
    isTrustedPdfOpenGeometryCurrent,
    invalidateTrustedPdfOpenGeometry,
    peekTrustedPdfOpenGeometry,
    prevalidateTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
    rememberValidatedTrustedPdfOpenGeometry,
    shouldApplyTrustedPdfOpenGeometry,
    type IPdfTrustedOpenGeometry,
    writeTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';

const entry: IPdfTrustedOpenGeometry = {
    documentId: '/documents/scan.pdf',
    size: 28_000_000,
    modifiedAt: 1_750_000_000_000,
    pageNumber: 7,
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
        invalidateTrustedPdfOpenGeometry(entry.documentId, 1);
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
            pageNumber: 1,
            pageCount: entry.pageCount,
            width: entry.width,
            height: entry.height,
            rotation: entry.rotation,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
        };

        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            1,
            async () => {
                throw new Error('stat is unnecessary on a cache miss');
            },
            async () => openingGeometry,
        )).resolves.toMatchObject({
            documentId: entry.documentId,
            ...openingGeometry,
        });
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, 1)).toMatchObject(openingGeometry);
    });

    it('replaces a persistent entry through fenced geometry when direct source stat is unavailable', async () => {
        const staleEntry = {
            ...entry,
            pageNumber: 1,
        };
        const openingGeometry = {
            pageNumber: 1,
            pageCount: entry.pageCount,
            width: entry.width,
            height: entry.height,
            rotation: entry.rotation,
            size: entry.size + 1,
            modifiedAt: entry.modifiedAt + 1,
        };
        writeTrustedPdfOpenGeometry(staleEntry);

        await expect(prevalidateTrustedPdfOpenGeometry(
            entry.documentId,
            1,
            async () => {
                throw new Error('original source stat is not a managed read');
            },
            async () => openingGeometry,
        )).resolves.toMatchObject(openingGeometry);
        expect(readPrevalidatedTrustedPdfOpenGeometry(entry.documentId, 1)).toMatchObject(openingGeometry);
        expect(peekTrustedPdfOpenGeometry(entry.documentId, 1)).toMatchObject(openingGeometry);
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

        expect(peekTrustedPdfOpenGeometry(entry.documentId, 7)).toEqual(entry);
        expect(peekTrustedPdfOpenGeometry(entry.documentId, 1)).toBeNull();

        invalidateTrustedPdfOpenGeometry(entry.documentId, 7);
        expect(peekTrustedPdfOpenGeometry(entry.documentId, 7)).toBeNull();
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
        }, entry.pageNumber + 1)).toBe(false);
    });

    it('ignores a cache lookup that resolves after authoritative PDF.js metrics', () => {
        expect(shouldApplyTrustedPdfOpenGeometry({
            lookupGeneration: 3,
            currentLookupGeneration: 3,
            openSurfaceGeneration: 8,
            currentOpenSurfaceGeneration: 8,
            source: 'scan',
            currentSource: 'scan',
            hasPdfDocument: true,
            authoritativeMetricCount: 431,
        })).toBe(false);
    });

    it('allows a fingerprinted original-path result before the working-copy source commits', () => {
        expect(shouldApplyTrustedPdfOpenGeometry({
            lookupGeneration: 3,
            currentLookupGeneration: 3,
            openSurfaceGeneration: 8,
            currentOpenSurfaceGeneration: 8,
            source: null,
            currentSource: null,
            hasPdfDocument: false,
            authoritativeMetricCount: 0,
        })).toBe(true);
    });

    it('rejects a validated cache result after any page geometry is authoritative', () => {
        expect(shouldApplyTrustedPdfOpenGeometry({
            lookupGeneration: 4,
            currentLookupGeneration: 4,
            openSurfaceGeneration: 9,
            currentOpenSurfaceGeneration: 9,
            source: 'working-copy',
            currentSource: 'working-copy',
            hasPdfDocument: false,
            authoritativeMetricCount: 1,
        })).toBe(false);
    });

    it('keeps a mixed-page document seed provisional so every page is authoritatively replaced', () => {
        const seed = buildTrustedPdfGeometrySeed({
            pageNumber: 7,
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
