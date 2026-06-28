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

function readSource(relativePath: string) {
    return readFileSync(
        resolve(repoRoot, relativePath),
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
        const source = readSource('app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime.ts');
        const inactiveWatcher = source.match(/watch\(\s*\(\) => source\.isActive\.value,[\s\S]*?\{[\s\S]*?flush: 'post'/u)?.[0] ?? '';

        expect(inactiveWatcher).toContain('effects.cancelActivePaneRefresh();');
        expect(inactiveWatcher).toContain('cancelAllRenders();');
        expect(inactiveWatcher).toContain('incrementRenderGeneration();');
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
