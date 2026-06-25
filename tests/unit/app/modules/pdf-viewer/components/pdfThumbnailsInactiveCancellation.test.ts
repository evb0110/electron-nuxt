import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createThumbnailRenderState,
    type IThumbnailRenderTask,
} from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderState';
import { isThumbnailRenderGenerationCurrent } from '@app/modules/pdf-viewer/thumbnails/isThumbnailRenderGenerationCurrent';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readPdfThumbnailsSource() {
    return readFileSync(
        resolve(repoRoot, 'app/modules/pdf-viewer/components/PdfThumbnails.vue'),
        'utf8',
    );
}

interface ITestCanvas { name: string; }

function createCanvas(): ITestCanvas {
    return {name: 'canvas'};
}

function createRenderTask(cancel = vi.fn()) {
    return {
        cancel,
        task: {cancel} satisfies IThumbnailRenderTask,
    };
}

describe('PdfThumbnails inactive cancellation lifecycle', () => {
    it('keeps the inactive watcher wired to cancel refreshes, renders, and stale generations', () => {
        const source = readPdfThumbnailsSource();
        const inactiveWatcher = source.match(/watch\(\s*\(\) => isActive \?\? true,[\s\S]*?\{[\s\S]*?flush: 'post'/u)?.[0] ?? '';

        expect(inactiveWatcher).toContain('cancelActivePaneRefresh();');
        expect(inactiveWatcher).toContain('cancelAllRenders();');
        expect(inactiveWatcher).toContain('renderRunId += 1;');
    });

    it('cancels active render work through the thumbnail render state boundary', () => {
        const state = createThumbnailRenderState<ITestCanvas>();
        const abortController = new AbortController();
        const renderTask = createRenderTask();

        state.beginRender({
            page: 1,
            canvas: createCanvas(),
            renderKey: 'active',
        });
        state.trackAbortController(1, abortController);
        state.trackRenderTask(1, renderTask.task);

        state.cancelAll();

        expect(abortController.signal.aborted).toBe(true);
        expect(renderTask.cancel).toHaveBeenCalledTimes(1);
        expect(state.createSnapshot()).toMatchObject({
            activeTasks: [],
            renderingCount: 0,
        });
    });

    it('invalidates old thumbnail generations when the pane becomes inactive', () => {
        const runId = 4;
        const nextRenderRunId = 5;

        expect(isThumbnailRenderGenerationCurrent({
            runId,
            renderRunId: nextRenderRunId,
            isDocumentUsable: true,
            isPaneActive: false,
        })).toBe(false);
    });
});
