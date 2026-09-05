import {
    mkdtemp,
    readdir,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createFileBackedScanCleanupDetectionResultStore,
    createFileBackedScanCleanupResultStore,
} from '@scan-cleanup-core/fileBackedResultStore';
import {runLosslessScanCleanup} from '@scan-cleanup-core/runLosslessScanCleanup';
import {resolveScanCleanupPageScopeLazy} from '@scan-cleanup-core/pageScope';
import type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
    TScanCleanupLog,
} from '@scan-cleanup-core/types';
import type {IPdfPageSizeStore} from '@scan-cleanup-core/pdfPageSizes';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';

const roots: string[] = [];

interface IClassificationRecord {
    pageNumber: number;
    classification: string;
}

interface IValueRecord {
    pageNumber: number;
    value: string;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('file-backed scan-cleanup result store', () => {
    it('omits analysis-only diagnostics from persisted detection records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupDetectionResultStore({
            pageCount: 1,
            rootDir: root,
        });
        const outputModeDiagnostics = {rule: 'blank'} as NonNullable<
            IScanCleanupDetectionResult['outputModeDiagnostics']
        >;
        const result: IScanCleanupDetectionResult = {
            pageNumber: requirePageNumber(1),
            revision: 1,
            classification: 'single-uncut-page',
            confidence: 1,
            cutterXPx: null,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 1,
            documentPrior: null,
            recommendedOutputMode: 'grayscale',
            outputModeDiagnostics,
            pagePlanEvidence: {
                pageNumber: requirePageNumber(1),
                rotationDegrees: 0,
                layoutClassification: 'single-uncut-page',
                outputs: {},
            },
        };

        await store.append(result);

        const persisted = await store.getPage(1);
        expect(persisted).not.toHaveProperty('outputModeDiagnostics');
        expect(persisted?.recommendedOutputMode).toBe('grayscale');
        expect(persisted?.pagePlanEvidence).toEqual(result.pagePlanEvidence);
        await store.close();
    });

    it('keeps million-page indexes sparse and limits reads to bounded windows', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupResultStore<IClassificationRecord>({
            maxReadPages: 2,
            pageCount: 1_000_000,
            pageNumberOf: record => record.pageNumber,
            rootDir: root,
        });
        await store.append({
            pageNumber: 1,
            classification: 'first',
        });
        await store.append({
            pageNumber: 1_000_000,
            classification: 'last',
        });

        expect(await readdir(root)).toHaveLength(1);
        expect(store.pageCount).toBe(1_000_000);
        expect(store.resultCount).toBe(2);
        expect(await store.getPage(1)).toEqual({
            pageNumber: 1,
            classification: 'first',
        });
        expect(await store.readRange(999_999, 1_000_001)).toEqual([{
            pageNumber: 1_000_000,
            classification: 'last',
        }]);
        await expect(store.readRange(1, 4)).rejects.toThrow('bounded window');

        await store.close();
        await store.close();
        expect(await readdir(root)).toEqual([]);
    });

    it('replaces a record in place and iterates bounded chunks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupResultStore<IValueRecord>({
            maxReadPages: 2,
            pageCount: 4,
            pageNumberOf: record => record.pageNumber,
            rootDir: root,
        });
        await store.append({
            pageNumber: 1,
            value: 'old',
        });
        await store.append({
            pageNumber: 3,
            value: 'three',
        });
        await store.replace(1, {
            pageNumber: 1,
            value: 'new',
        });

        expect(await store.getPage(1)).toEqual({
            pageNumber: 1,
            value: 'new',
        });
        const chunks: Array<{
            firstPageNumber: number;
            records: unknown[]
        }> = [];
        await store.forEachChunk((records, firstPageNumber) => {
            chunks.push({
                firstPageNumber,
                records: [...records],
            });
        });
        expect(chunks).toEqual([
            {
                firstPageNumber: 1,
                records: [{
                    pageNumber: 1,
                    value: 'new',
                }],
            },
            {
                firstPageNumber: 3,
                records: [{
                    pageNumber: 3,
                    value: 'three',
                }],
            },
        ]);

        await store.close();
    });

    it('skips a repeated lossless canvas prepass for a supplied parent canvas', async () => {
        const pageCount = 20_001;
        const forEachChunk = vi.fn(async () => undefined);
        const pageSizeStore: IPdfPageSizeStore = {
            pageCount,
            getPage: vi.fn(),
            readRange: vi.fn(),
            forEachChunk,
            close: vi.fn(async () => undefined),
        };
        const controller = new AbortController();
        controller.abort(new Error('lossless child canceled'));
        const request = {
            options: {matchPageSize: true},
            outputPdfPath: '/tmp/scan-cleanup-output.pdf',
            sourcePdfPath: '/tmp/scan-cleanup-source.pdf',
        } as IRunScanCleanupPipelineRequest;
        const paths = {
            pdfImageCombineBinary: 'pdf-image-combine',
            pdfPageOpsBinary: 'pdf-page-ops',
            pdftoppmBinary: 'pdftoppm',
            qpdfBinary: 'qpdf',
            scanCleanupBinary: 'scan-cleanup',
            tempDir: '/tmp',
        } as IScanCleanupWorkerPaths;
        const dependencies = {} as IRunScanCleanupPipelineDependencies;
        const policy = {} as IScanCleanupRuntimePolicy;
        const dpiSource = {
            detected: false,
            documentDpi: 300,
            getPageRaster: () => undefined,
        };
        const pageNumbers = resolveScanCleanupPageScopeLazy(undefined, pageCount);

        await expect(runLosslessScanCleanup(
            request,
            paths,
            request.sourcePdfPath,
            [],
            pageNumbers,
            pageSizeStore,
            dpiSource,
            '/tmp',
            '/tmp/scan-cleanup-staged.pdf',
            controller.signal,
            vi.fn(),
            (() => undefined) as TScanCleanupLog,
            policy,
            dependencies,
            {documentCanvas: {
                heightPoints: 792,
                heightPx: 3_300,
                widthPoints: 612,
                widthPx: 2_550,
            }},
        )).rejects.toThrow('lossless child canceled');
        expect(forEachChunk).not.toHaveBeenCalled();
        expect(pageSizeStore.readRange).not.toHaveBeenCalled();
    });
});
