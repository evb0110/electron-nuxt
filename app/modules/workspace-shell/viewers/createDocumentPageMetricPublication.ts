import type { IDocumentPageMetrics } from '@app/utils/document-viewer/source/documentPageSource';
import {
    createRafCoalescedCallback,
    type IRafCoalescedCallbackEnvironment,
} from '@app/utils/createRafCoalescedCallback';

interface ICreateDocumentPageMetricPublicationOptions {
    readMetrics: () => readonly IDocumentPageMetrics[];
    commitMetrics: (metrics: IDocumentPageMetrics[]) => void;
    onPublished: () => void;
}

/** Frame-batches exact metric discovery so large documents do not rebuild all geometry per page. */
export function createDocumentPageMetricPublication(
    options: ICreateDocumentPageMetricPublicationOptions,
    environment?: IRafCoalescedCallbackEnvironment,
) {
    const pendingMetrics = new Map<number, IDocumentPageMetrics>();

    function flush() {
        if (pendingMetrics.size === 0) {
            return;
        }
        const nextMetrics = options.readMetrics().slice();
        for (const [
            pageNumber,
            metric,
        ] of pendingMetrics) nextMetrics[pageNumber - 1] = metric;
        pendingMetrics.clear();
        options.commitMetrics(nextMetrics);
        options.onPublished();
    }

    const schedule = createRafCoalescedCallback(flush, environment);
    function clear() {
        pendingMetrics.clear();
        schedule.cancel();
    }

    return {
        clear,
        enqueue(pageNumber: number, metric: IDocumentPageMetrics) {
            pendingMetrics.set(pageNumber, metric);
            schedule.schedule();
        },
        flush,
    };
}
