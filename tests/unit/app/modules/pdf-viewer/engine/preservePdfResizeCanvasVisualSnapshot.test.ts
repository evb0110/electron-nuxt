// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { preservePdfResizeCanvasVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-resize-visual-snapshot/preservePdfResizeCanvasVisualSnapshot';

describe('preservePdfResizeCanvasVisualSnapshot', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    it('keeps an independent canvas until a replacement commits', () => {
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as never);
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container page_container--rendered';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        canvasHost.append(sourceCanvas);
        pageCanvas.append(canvasHost);
        pageContainer.append(pageCanvas);
        document.body.append(pageContainer);

        const snapshot = preservePdfResizeCanvasVisualSnapshot(pageContainer);

        expect(snapshot).not.toBeNull();
        expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 0, 0);
        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(true);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).not.toBeNull();
        expect(snapshot?.hasReplacementCanvas()).toBe(false);
        expect(snapshot?.isValid()).toBe(true);

        pageContainer.classList.remove('page_container--rendered');
        const replacementCanvas = document.createElement('canvas');
        canvasHost.replaceChildren(replacementCanvas);
        expect(snapshot?.hasReplacementCanvas()).toBe(false);

        replacementCanvas.width = 800;
        replacementCanvas.height = 1_200;
        expect(snapshot?.hasReplacementCanvas()).toBe(false);

        pageContainer.classList.add('page_container--rendered');
        canvasHost.style.visibility = 'hidden';
        expect(snapshot?.hasReplacementCanvas()).toBe(false);

        canvasHost.style.visibility = 'visible';
        expect(snapshot?.hasReplacementCanvas()).toBe(true);

        snapshot?.release();
        expect(snapshot?.isValid()).toBe(false);
        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(false);
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).toBeNull();
        expect(canvasHost.firstElementChild).toBe(replacementCanvas);
    });

    it('skips a renderer canvas that has already released its bitmap', () => {
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as never);
        const pageContainer = document.createElement('div');
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
        canvasHost.append(sourceCanvas);
        pageCanvas.append(canvasHost);
        pageContainer.append(pageCanvas);

        expect(preservePdfResizeCanvasVisualSnapshot(pageContainer)).toBeNull();
        expect(drawImage).not.toHaveBeenCalled();
    });

    it('does not expose a canvas before the page is canonically rendered', () => {
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as never);
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        canvasHost.append(sourceCanvas);
        pageCanvas.append(canvasHost);
        pageContainer.append(pageCanvas);
        document.body.append(pageContainer);

        expect(preservePdfResizeCanvasVisualSnapshot(pageContainer)).toBeNull();
        expect(drawImage).not.toHaveBeenCalled();
        expect(pageCanvas.querySelector('.pdf-resize-canvas-snapshot')).toBeNull();
    });

    it('refuses to duplicate a live snapshot', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: vi.fn()} as never);
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container page_container--rendered';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        canvasHost.append(sourceCanvas);
        pageCanvas.append(canvasHost);
        pageContainer.append(pageCanvas);
        document.body.append(pageContainer);

        const first = preservePdfResizeCanvasVisualSnapshot(pageContainer);
        const second = preservePdfResizeCanvasVisualSnapshot(pageContainer);
        expect(second).toBeNull();
        expect(pageCanvas.querySelectorAll('.pdf-resize-canvas-snapshot')).toHaveLength(1);

        first?.release();

        expect(pageCanvas.classList.contains('page_canvas--resize-visual-snapshot')).toBe(false);
    });

    it('removes an invalid orphan before recapturing', () => {
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as never);
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container page_container--rendered';
        const pageCanvas = document.createElement('div');
        pageCanvas.className = 'page_canvas';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = 640;
        sourceCanvas.height = 960;
        const orphan = document.createElement('canvas');
        orphan.className = 'pdf-resize-canvas-snapshot';
        orphan.width = 0;
        orphan.height = 0;
        canvasHost.append(sourceCanvas);
        pageCanvas.append(canvasHost, orphan);
        pageContainer.append(pageCanvas);
        document.body.append(pageContainer);

        const snapshot = preservePdfResizeCanvasVisualSnapshot(pageContainer);

        expect(snapshot?.isValid()).toBe(true);
        expect(orphan.isConnected).toBe(false);
        expect(pageCanvas.querySelectorAll('.pdf-resize-canvas-snapshot')).toHaveLength(1);
    });
});
