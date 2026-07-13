import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    acquireEmbeddedShapeImport,
    createEmbeddedShapeImportCacheKey,
    getEmbeddedShapeImportCacheSnapshot,
    invalidateEmbeddedShapeImportCache,
} from '@app/modules/pdf-viewer/runtime/annotations/embeddedShapeImportCache';

const SHAPE = {
    id: 'shape-1',
    type: 'rectangle',
    pageIndex: 0,
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    color: '#000000',
    opacity: 1,
    strokeWidth: 1,
    source: 'embedded',
} as IShapeAnnotation;

afterEach(() => invalidateEmbeddedShapeImportCache());

describe('embeddedShapeImportCache', () => {
    it('shares one import while keeping subscriber cancellation isolated', async () => {
        const loaded = Promise.withResolvers<IShapeAnnotation[]>();
        const loader = vi.fn(async (_signal: AbortSignal) => loaded.promise);
        const key = createEmbeddedShapeImportCacheKey({
            data: null,
            path: '/tmp/shared.pdf',
            documentRevisionToken: requireDocumentRevisionToken('revision-shared'),
        });
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = acquireEmbeddedShapeImport(key, loader, firstController.signal);
        const second = acquireEmbeddedShapeImport(key, loader, secondController.signal);
        firstController.abort();

        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(loader).toHaveBeenCalledOnce();
        expect(loader.mock.calls[0]?.[0].aborted).toBe(false);

        loaded.resolve([SHAPE]);
        const secondResult = await second;
        const cachedResult = await acquireEmbeddedShapeImport(
            key,
            loader,
            new AbortController().signal,
        );

        expect(secondResult).toEqual([SHAPE]);
        expect(cachedResult).toEqual([SHAPE]);
        expect(cachedResult).not.toBe(secondResult);
        expect(cachedResult[0]).not.toBe(secondResult[0]);
        expect(loader).toHaveBeenCalledOnce();
    });

    it('aborts and evicts in-flight work only after its last subscriber leaves', async () => {
        const loaderSignals: AbortSignal[] = [];
        const loader = vi.fn((signal: AbortSignal) => {
            loaderSignals.push(signal);
            return new Promise<IShapeAnnotation[]>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });
        const key = createEmbeddedShapeImportCacheKey({
            data: null,
            path: '/tmp/cancelled.pdf',
            documentRevisionToken: requireDocumentRevisionToken('revision-cancelled'),
        });
        const controller = new AbortController();

        const request = acquireEmbeddedShapeImport(key, loader, controller.signal);
        controller.abort();

        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(loaderSignals[0]?.aborted).toBe(true));
        expect(getEmbeddedShapeImportCacheSnapshot()).toEqual({
            entryCount: 0,
            completedEntryCount: 0,
            inFlightEntryCount: 0,
        });
    });

    it('keeps fingerprinted source work alive across a zero-subscriber reopen gap', async () => {
        const loaded = Promise.withResolvers<IShapeAnnotation[]>();
        const loaderSignals: AbortSignal[] = [];
        const loader = vi.fn((signal: AbortSignal) => {
            loaderSignals.push(signal);
            return loaded.promise;
        });
        const key = createEmbeddedShapeImportCacheKey({
            data: null,
            path: '/tmp/work-1/scan.pdf',
            documentRevisionToken: requireDocumentRevisionToken('work-1'),
            stableSourceIdentity: 'original:/documents/scan.pdf:28000000:1750000000000',
        });
        const firstController = new AbortController();
        const first = acquireEmbeddedShapeImport(
            key,
            loader,
            firstController.signal,
            {retainInFlightWithoutSubscribers: true},
        );

        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(loaderSignals[0]?.aborted).toBe(false);
        expect(getEmbeddedShapeImportCacheSnapshot()).toEqual({
            entryCount: 1,
            completedEntryCount: 0,
            inFlightEntryCount: 1,
        });

        const reopened = acquireEmbeddedShapeImport(
            key,
            loader,
            new AbortController().signal,
            {retainInFlightWithoutSubscribers: true},
        );
        loaded.resolve([SHAPE]);

        await expect(reopened).resolves.toEqual([SHAPE]);
        expect(loader).toHaveBeenCalledOnce();
    });

    it('bounds retained source work after subscribers leave', async () => {
        const loaderSignals: AbortSignal[] = [];
        const loader = vi.fn((signal: AbortSignal) => {
            loaderSignals.push(signal);
            return new Promise<IShapeAnnotation[]>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });

        for (let source = 1; source <= 3; source += 1) {
            const controller = new AbortController();
            const request = acquireEmbeddedShapeImport(
                createEmbeddedShapeImportCacheKey({
                    data: null,
                    path: `/tmp/work-${source}/scan.pdf`,
                    documentRevisionToken: requireDocumentRevisionToken(`work-${source}`),
                    stableSourceIdentity: `original:/documents/scan-${source}.pdf`,
                }),
                loader,
                controller.signal,
                {retainInFlightWithoutSubscribers: true},
            );
            controller.abort();
            await expect(request).rejects.toMatchObject({name: 'AbortError'});
        }

        await vi.waitFor(() => expect(loaderSignals[0]?.aborted).toBe(true));
        expect(loaderSignals[1]?.aborted).toBe(false);
        expect(loaderSignals[2]?.aborted).toBe(false);
        expect(getEmbeddedShapeImportCacheSnapshot()).toEqual({
            entryCount: 2,
            completedEntryCount: 0,
            inFlightEntryCount: 2,
        });
    });

    it('separates revisions and bounds completed results with least-recent eviction', async () => {
        const loader = vi.fn(async () => [SHAPE]);
        const path = '/tmp/revised.pdf';
        const firstKey = createEmbeddedShapeImportCacheKey({
            data: null,
            path,
            documentRevisionToken: requireDocumentRevisionToken('revision-0'),
        });
        await acquireEmbeddedShapeImport(firstKey, loader, new AbortController().signal);

        for (let revision = 1; revision <= 8; revision += 1) {
            const key = createEmbeddedShapeImportCacheKey({
                data: null,
                path,
                documentRevisionToken: requireDocumentRevisionToken(`revision-${revision}`),
            });
            await acquireEmbeddedShapeImport(key, loader, new AbortController().signal);
        }

        expect(loader).toHaveBeenCalledTimes(9);
        expect(getEmbeddedShapeImportCacheSnapshot()).toEqual({
            entryCount: 8,
            completedEntryCount: 8,
            inFlightEntryCount: 0,
        });
        await acquireEmbeddedShapeImport(firstKey, loader, new AbortController().signal);
        expect(loader).toHaveBeenCalledTimes(10);
    });

    it('reuses a completed import across regenerated working copies of one unchanged original', async () => {
        const loader = vi.fn(async () => [SHAPE]);
        const stableSourceIdentity = JSON.stringify([
            '/documents/scan.pdf',
            28_000_000,
            1_750_000_000_000,
        ]);
        const firstKey = createEmbeddedShapeImportCacheKey({
            data: null,
            path: '/tmp/pdf-work-1/scan.pdf',
            documentRevisionToken: requireDocumentRevisionToken('working-copy-1'),
            stableSourceIdentity,
        });
        const secondKey = createEmbeddedShapeImportCacheKey({
            data: null,
            path: '/tmp/pdf-work-2/scan.pdf',
            documentRevisionToken: requireDocumentRevisionToken('working-copy-2'),
            stableSourceIdentity,
        });

        expect(secondKey).toBe(firstKey);
        await acquireEmbeddedShapeImport(firstKey, loader, new AbortController().signal);
        await acquireEmbeddedShapeImport(secondKey, loader, new AbortController().signal);

        expect(loader).toHaveBeenCalledOnce();
    });
});
