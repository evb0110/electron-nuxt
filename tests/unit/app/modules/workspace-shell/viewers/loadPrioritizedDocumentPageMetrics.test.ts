import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    hydrateRemainingDocumentPageMetrics,
    loadInitialDocumentPageMetric,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';

function createSource(pageCount: number) {
    const calls: number[] = [];
    const source: IDocumentPageSource = {
        kind: 'djvu',
        documentRef: '/documents/scan.djvu',
        pageCount,
        async getPageMetrics(pageNumber: number) {
            calls.push(pageNumber);
            return {
                widthPoints: 600 + pageNumber,
                heightPoints: 800 + pageNumber,
                rotation: 0 as const,
            };
        },
        renderPage: vi.fn(async () => {
            throw new Error('renderPage is outside this metrics test');
        }),
        dispose: vi.fn(),
    };
    return {
        calls,
        source,
    };
}

describe('prioritized document page metrics', () => {
    it('fences page rendering on exact per-page metric readiness', () => {
        const featurePack = readFileSync(join(
            process.cwd(),
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
        ), 'utf8');

        expect(featurePack).toContain('const exactPageMetricNumbers = new Set<number>();');
        expect(featurePack).toContain('if (!exactPageMetricNumbers.has(pageNumber))');
        expect(featurePack).toContain('if (pageNumber !== currentPage)');
        expect(featurePack).toContain('onMetric: () => scheduleRender.schedule(),');
    });

    it('keeps a stable cold-open page frame before trusted metrics arrive', () => {
        const metrics = createColdOpenProvisionalDocumentPageMetrics(7);

        expect(metrics).toHaveLength(7);
        expect(metrics[6]).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        });
    });

    it('creates a complete provisional page-shell model from the prioritized metric', () => {
        const initialMetric = {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0 as const,
        };

        const metrics = createProvisionalDocumentPageMetrics(431, initialMetric);

        expect(metrics).toHaveLength(431);
        expect(metrics.every(metric => (
            metric.widthPoints === 600
            && metric.heightPoints === 800
            && metric.rotation === 0
        ))).toBe(true);
        expect(metrics[0]).not.toBe(metrics[1]);
    });

    it('loads only the initial page on the first-visual critical path', async () => {
        const {
            calls,
            source,
        } = createSource(400);
        const metric = await loadInitialDocumentPageMetric(source, 7, new AbortController().signal);

        expect(calls).toEqual([7]);
        expect(metric).toMatchObject({
            widthPoints: 607,
            heightPoints: 807,
        });
    });

    it('hydrates remaining metrics nearest-first after the initial page commits', async () => {
        const {
            calls,
            source,
        } = createSource(5);
        const metrics = await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 3,
            initialMetric: {
                widthPoints: 603,
                heightPoints: 803,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
        });

        expect(calls).toEqual([
            2,
            4,
            1,
            5,
        ]);
        expect(metrics?.map(metric => metric.widthPoints)).toEqual([
            601,
            602,
            603,
            604,
            605,
        ]);
    });

    it('publishes exact metrics incrementally instead of waiting for the full document', async () => {
        const {
            calls,
            source,
        } = createSource(4);
        const published: number[] = [];

        await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
            onMetric: pageNumber => published.push(pageNumber),
        });

        expect(published).toEqual(calls);
        expect(published).toEqual([
            2,
            3,
            4,
        ]);
    });

    it('reprioritizes the next metric around the latest requested target page', async () => {
        const {
            calls,
            source,
        } = createSource(6);
        let priorityPage = 2;

        await hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            concurrency: 1,
            getPriorityPage: () => priorityPage,
            onMetric: () => {
                priorityPage = 6;
            },
        });

        expect(calls.slice(0, 2)).toEqual([
            2,
            6,
        ]);
    });

    it('drops background metrics when the source generation is superseded', async () => {
        const {
            calls,
            source,
        } = createSource(5);
        let current = true;
        const originalGetPageMetrics = source.getPageMetrics.bind(source);
        source.getPageMetrics = async (pageNumber, signal) => {
            const metric = await originalGetPageMetrics(pageNumber, signal);
            current = false;
            return metric;
        };

        await expect(hydrateRemainingDocumentPageMetrics({
            source,
            initialPage: 1,
            initialMetric: {
                widthPoints: 601,
                heightPoints: 801,
                rotation: 0,
            },
            signal: new AbortController().signal,
            isCurrent: () => current,
            concurrency: 1,
        })).resolves.toBeNull();
        expect(calls).toEqual([2]);
    });
});
