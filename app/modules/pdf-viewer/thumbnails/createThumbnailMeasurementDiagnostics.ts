import { BrowserLogger } from '@app/utils/browserLogger';

type TThumbnailMeasurementGeometry = Record<string, number>;
type TThumbnailMeasurementState = 'ready' | 'no-item' | 'no-rendered-canvas';

interface IThumbnailMeasurementDiagnosticsOptions {
    currentPage: () => number;
    describeContainerGeometry: (container: HTMLElement) => TThumbnailMeasurementGeometry;
    logSection: string;
    totalPages: () => number;
}

export function createThumbnailMeasurementDiagnostics(
    options: IThumbnailMeasurementDiagnosticsOptions,
) {
    let state: TThumbnailMeasurementState = 'ready';

    function findRenderedItem(container: HTMLElement) {
        return Array.from(
            container.querySelectorAll<HTMLElement>('.pdf-thumbnail'),
        ).find((candidate) => {
            const canvas = candidate.querySelector<HTMLCanvasElement>('canvas');
            return Boolean(
                canvas
                && canvas.width > 0
                && canvas.height > 0
                && canvas.getBoundingClientRect().height > 0,
            );
        }) ?? null;
    }

    function measure(container: HTMLElement) {
        const item = container.querySelector<HTMLElement>('.pdf-thumbnail');
        if (!item) {
            if (state !== 'no-item') {
                state = 'no-item';
                BrowserLogger.diagnostic(options.logSection, 'Skipping thumbnail height measurement: no thumbnail items', {
                    currentPage: options.currentPage(),
                    totalPages: options.totalPages(),
                    geometry: options.describeContainerGeometry(container),
                });
            }
            return;
        }

        const renderedItem = findRenderedItem(container);
        const measurementItem = renderedItem ?? item;
        const canvas = measurementItem.querySelector<HTMLCanvasElement>('canvas');
        if (!renderedItem || !canvas) {
            if (state !== 'no-rendered-canvas') {
                state = 'no-rendered-canvas';
                BrowserLogger.diagnostic(options.logSection, 'Skipping thumbnail height measurement: no rendered canvas in virtual window yet', {
                    currentPage: options.currentPage(),
                    totalPages: options.totalPages(),
                    geometry: options.describeContainerGeometry(container),
                    itemPage: measurementItem.dataset.page ?? null,
                    canvasWidth: canvas?.width ?? null,
                    canvasHeight: canvas?.height ?? null,
                });
            }
            return;
        }

        if (state !== 'ready') {
            state = 'ready';
            BrowserLogger.diagnostic(options.logSection, 'Thumbnail height measurement resumed with rendered canvas', {
                currentPage: options.currentPage(),
                totalPages: options.totalPages(),
                itemPage: measurementItem.dataset.page ?? null,
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
            });
        }
        BrowserLogger.diagnostic(options.logSection, 'Thumbnail layout measurement checked', {
            geometry: options.describeContainerGeometry(container),
            itemPage: measurementItem.dataset.page ?? null,
        });
    }

    return {
        isReady: () => state === 'ready',
        measure,
        reset: () => {
            state = 'ready';
        },
    };
}
