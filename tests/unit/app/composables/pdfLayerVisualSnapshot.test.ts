// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { hasPdfPageAnnotationVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageAnnotationVisualContent';
import { hasPdfPageAnnotationVisualContentForSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageAnnotationVisualContentForSnapshotRelease';
import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';
import { preservePdfDrawLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfDrawLayerVisualSnapshot';
import { preservePdfLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfLayerVisualSnapshot';
import { preservePdfPageAnnotationVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfPageAnnotationVisualSnapshot';
import { schedulePdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/schedulePdfLayerVisualSnapshotRelease';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function withVisibleRect<T extends Element>(element: T) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            bottom: 20,
            height: 20,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }),
    });
    return element;
}

function createElement(tagName = 'div') {
    const element = withVisibleRect(document.createElement(tagName));
    document.body.append(element);
    return element;
}

function createSvg(className: string) {
    const svg = withVisibleRect(document.createElementNS(SVG_NAMESPACE, 'svg'));
    svg.classList.add(className);
    document.body.append(svg);
    return svg;
}

function installRequestAnimationFrameQueue() {
    const callbacks: FrameRequestCallback[] = [];
    const hadRequestAnimationFrame = 'requestAnimationFrame' in window;
    const originalRequestAnimationFrame = window.requestAnimationFrame;

    Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: vi.fn((callback: FrameRequestCallback) => {
            callbacks.push(callback);
            return callbacks.length;
        }),
    });

    return {
        callbacks,
        restore: () => {
            if (hadRequestAnimationFrame) {
                Object.defineProperty(window, 'requestAnimationFrame', {
                    configurable: true,
                    value: originalRequestAnimationFrame,
                });
                return;
            }
            Reflect.deleteProperty(window, 'requestAnimationFrame');
        },
        runNextFrame: () => callbacks.shift()?.(Date.now()),
    };
}

describe('pdfLayerVisualSnapshot', () => {
    beforeEach(() => {
        document.body.replaceChildren();
    });

    it('releases after the minimum frame count when waitFor stays false without a max delay', () => {
        const animationFrame = installRequestAnimationFrameQueue();
        try {
            const release = vi.fn();
            const waitFor = vi.fn(() => false);

            schedulePdfLayerVisualSnapshotRelease(release, { waitFor });

            expect(release).not.toHaveBeenCalled();
            expect(animationFrame.callbacks).toHaveLength(1);

            animationFrame.runNextFrame();

            expect(waitFor).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
            expect(animationFrame.callbacks).toHaveLength(0);
        } finally {
            animationFrame.restore();
        }
    });

    it('keeps waiting for false predicates until a positive max delay elapses', () => {
        const animationFrame = installRequestAnimationFrameQueue();
        const dateNow = vi.spyOn(Date, 'now');
        let now = 0;
        dateNow.mockImplementation(() => now);
        try {
            const release = vi.fn();

            schedulePdfLayerVisualSnapshotRelease(release, {
                maxDelayMs: 100,
                waitFor: () => false,
            });

            animationFrame.runNextFrame();
            expect(release).not.toHaveBeenCalled();
            expect(animationFrame.callbacks).toHaveLength(1);

            now = 99;
            animationFrame.runNextFrame();
            expect(release).not.toHaveBeenCalled();
            expect(animationFrame.callbacks).toHaveLength(1);

            now = 100;
            animationFrame.runNextFrame();
            expect(release).toHaveBeenCalledTimes(1);
            expect(animationFrame.callbacks).toHaveLength(0);
        } finally {
            dateNow.mockRestore();
            animationFrame.restore();
        }
    });

    it('keeps a non-interactive layer clone until released', () => {
        const page = createElement();
        const layer = createElement();
        const button = createElement('button');
        layer.classList.add('annotation-editor-layer');
        button.setAttribute('id', 'editor-button');
        layer.append(button);
        page.append(layer);

        const release = preservePdfLayerVisualSnapshot(layer);
        const snapshot = page.lastElementChild;

        expect(release).toBeTypeOf('function');
        expect(snapshot).not.toBe(layer);
        expect(snapshot?.classList.contains(pdfLayerVisualSnapshotClass)).toBe(true);
        expect(snapshot?.getAttribute('aria-hidden')).toBe('true');
        expect(snapshot?.querySelector('button')?.tabIndex).toBe(-1);
        expect(layer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(true);
        expect(button.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);
        expect(button.style.visibility).toBe('hidden');
        expect(snapshot?.querySelector('button')?.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);

        release?.();

        expect(page.children).toHaveLength(1);
        expect(layer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
        expect(button.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(button.style.visibility).toBe('');
    });

    it('clones draw-layer SVGs that live under the canvas wrapper', () => {
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const canvas = createElement('canvas');
        const highlight = createSvg('highlight');
        const outline = createSvg('highlightOutline');
        const composite = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(
            canvas,
            highlight,
            outline,
            composite,
        );

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);
        const snapshots = Array.from(canvasHost.querySelectorAll<HTMLElement | SVGElement>(`.${pdfLayerVisualSnapshotClass}`));

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(3);
        expect(canvasHost.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(true);
        expect(snapshots.map(node => node.tagName.toLowerCase())).toEqual([
            'svg',
            'svg',
            'svg',
        ]);
        expect(highlight.style.visibility).toBe('hidden');
        expect(outline.style.visibility).toBe('hidden');
        expect(composite.style.visibility).toBe('hidden');
        expect(highlight.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);
        expect(outline.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);
        expect(composite.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);
        expect(snapshots.every(snapshot => snapshot.style.visibility === '')).toBe(true);

        release?.();

        expect(highlight.style.visibility).toBe('');
        expect(outline.style.visibility).toBe('');
        expect(composite.style.visibility).toBe('');
        expect(canvasHost.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
        expect(highlight.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(outline.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(composite.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(0);
    });

    it('allows snapshot releases to be called more than once', () => {
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const highlight = createSvg('highlight');
        canvasHost.append(highlight);

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);

        expect(release).toBeTypeOf('function');

        release?.();
        release?.();

        expect(highlight.style.visibility).toBe('');
        expect(highlight.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(canvasHost.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
        expect(canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(0);
    });

    it('does not clone hidden composite source highlights', () => {
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const hiddenCompositeSource = createSvg('highlight');
        hiddenCompositeSource.classList.add('pdf-highlight-composite-source');
        const visibleComposite = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(hiddenCompositeSource, visibleComposite);

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);
        const snapshots = canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.classList.contains('pdf-highlight-composite-overlay')).toBe(true);
    });

    it('suppresses fresh replacement draw visuals while a snapshot is active but allows release detection', () => {
        const page = createElement();
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const oldHighlight = createSvg('highlight');
        canvasHost.append(oldHighlight);
        page.append(canvasHost);

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);
        const freshOverlay = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(freshOverlay);

        expect(release).toBeTypeOf('function');
        expect(hasPdfPageAnnotationVisualContent(page)).toBe(false);
        expect(hasPdfPageAnnotationVisualContentForSnapshotRelease(page)).toBe(true);

        release?.();

        expect(hasPdfPageAnnotationVisualContent(page)).toBe(true);
    });

    it('rewrites cloned SVG ids so snapshot hrefs stay self-contained', () => {
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const highlight = createSvg('highlight');
        const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
        const path = document.createElementNS(SVG_NAMESPACE, 'path');
        const use = document.createElementNS(SVG_NAMESPACE, 'use');
        path.setAttribute('id', 'path_1');
        use.setAttribute('href', '#path_1');
        use.setAttribute('mask', 'url(#mask_1)');
        const mask = document.createElementNS(SVG_NAMESPACE, 'mask');
        mask.setAttribute('id', 'mask_1');
        defs.append(path, mask);
        highlight.append(defs, use);
        canvasHost.append(highlight);

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);
        const snapshot = canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)[0];
        const snapshotPath = snapshot?.querySelector('path');
        const snapshotMask = snapshot?.querySelector('mask');
        const snapshotUse = snapshot?.querySelector('use');

        expect(release).toBeTypeOf('function');
        expect(snapshotPath?.getAttribute('id')).not.toBe('path_1');
        expect(snapshotMask?.getAttribute('id')).not.toBe('mask_1');
        expect(snapshotUse?.getAttribute('href')).toBe(`#${snapshotPath?.getAttribute('id')}`);
        expect(snapshotUse?.getAttribute('mask')).toBe(`url(#${snapshotMask?.getAttribute('id')})`);
    });

    it('does not recursively clone existing draw-layer snapshots', () => {
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const liveHighlight = createSvg('highlight');
        const oldSnapshot = createSvg('highlight');
        oldSnapshot.classList.add(pdfLayerVisualSnapshotClass);
        canvasHost.append(liveHighlight, oldSnapshot);

        const release = preservePdfDrawLayerVisualSnapshot(canvasHost);
        const snapshots = canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(2);

        release?.();

        expect(canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(1);
    });

    it('does not stack page handoff snapshots while one is already active', () => {
        const page = createElement();
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const oldSnapshot = createSvg('highlight');
        oldSnapshot.classList.add(pdfLayerVisualSnapshotClass);
        const liveHighlight = createSvg('highlight');
        canvasHost.append(oldSnapshot, liveHighlight);
        page.append(canvasHost);

        const release = preservePdfPageAnnotationVisualSnapshot(
            page,
            null,
        );

        expect(release).toBeNull();
        expect(canvasHost.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(1);
    });

    it('preserves annotation, editor, and draw-layer visuals for a page handoff', () => {
        const page = createElement();
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        canvasHost.append(createSvg('highlight'));
        const annotationLayer = createElement();
        annotationLayer.classList.add('annotation-layer');
        annotationLayer.append(createElement());
        const editorLayer = createElement();
        editorLayer.classList.add('annotation-editor-layer');
        editorLayer.append(createElement());
        page.append(
            canvasHost,
            annotationLayer,
            editorLayer,
        );

        const release = preservePdfPageAnnotationVisualSnapshot(
            page,
            editorLayer,
        );

        expect(release).toBeTypeOf('function');
        expect(page.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(3);

        release?.();

        expect(page.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(0);
    });

    it('uses draw-layer snapshots instead of cloning text-markup editor rectangles', () => {
        const page = createElement();
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        canvasHost.append(createSvg('highlight'));
        const annotationLayer = createElement();
        annotationLayer.classList.add('annotation-layer');
        const editorReplica = createElement();
        editorReplica.classList.add('editorAnnotation');
        annotationLayer.append(editorReplica);
        const editorLayer = createElement();
        editorLayer.classList.add('annotation-editor-layer');
        const highlightEditor = createElement();
        highlightEditor.classList.add('highlightEditor');
        editorLayer.append(highlightEditor);
        page.append(
            canvasHost,
            annotationLayer,
            editorLayer,
        );

        const release = preservePdfPageAnnotationVisualSnapshot(
            page,
            editorLayer,
        );
        const snapshots = Array.from(page.querySelectorAll<HTMLElement | SVGElement>(`.${pdfLayerVisualSnapshotClass}`));

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.tagName.toLowerCase()).toBe('svg');
        expect(annotationLayer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(true);
        expect(editorLayer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(true);
        expect(editorReplica.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);
        expect(highlightEditor.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);

        release?.();

        expect(page.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(0);
        expect(annotationLayer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
        expect(editorLayer.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
        expect(editorReplica.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
        expect(highlightEditor.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
    });

    it('keeps subtype editor presentations in page handoff snapshots', () => {
        const page = createElement();
        const canvasHost = createElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        canvasHost.append(createSvg('highlight'));
        const editorLayer = createElement();
        editorLayer.classList.add('annotation-editor-layer');
        const underlineEditor = createElement();
        underlineEditor.classList.add('highlightEditor', 'pdf-markup-subtype-underline');
        editorLayer.append(underlineEditor);
        page.append(
            canvasHost,
            editorLayer,
        );

        const release = preservePdfPageAnnotationVisualSnapshot(
            page,
            editorLayer,
        );
        const snapshots = Array.from(page.querySelectorAll<HTMLElement | SVGElement>(`.${pdfLayerVisualSnapshotClass}`));
        const editorSnapshot = snapshots.find(snapshot => snapshot.tagName.toLowerCase() !== 'svg');

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(2);
        expect(editorSnapshot?.querySelector('.pdf-markup-subtype-underline')).not.toBeNull();
        expect(underlineEditor.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(true);

        release?.();

        expect(page.querySelectorAll(`.${pdfLayerVisualSnapshotClass}`)).toHaveLength(0);
        expect(underlineEditor.classList.contains(pdfLayerVisualSnapshotSourceClass)).toBe(false);
    });

    it('detects live page annotation visuals but ignores snapshot-only content', () => {
        const page = createElement();
        const annotationLayer = createElement();
        annotationLayer.classList.add('annotation-layer');
        const highlight = createElement();
        highlight.classList.add('highlightAnnotation');
        annotationLayer.append(highlight);
        page.append(annotationLayer);

        expect(hasPdfPageAnnotationVisualContent(page)).toBe(true);

        highlight.classList.add(pdfLayerVisualSnapshotSourceClass);

        expect(hasPdfPageAnnotationVisualContent(page)).toBe(false);

        highlight.classList.remove(pdfLayerVisualSnapshotSourceClass);
        highlight.classList.add(pdfLayerVisualSnapshotClass);

        expect(hasPdfPageAnnotationVisualContent(page)).toBe(false);
    });

    it('ignores visual descendants while their snapshot source parent is hidden', () => {
        const page = createElement();
        const annotationLayer = createElement();
        annotationLayer.classList.add('annotation-layer');
        const sourceWrapper = createElement();
        sourceWrapper.classList.add(pdfLayerVisualSnapshotSourceClass);
        const highlight = createElement();
        highlight.classList.add('highlightAnnotation');
        sourceWrapper.append(highlight);
        annotationLayer.append(sourceWrapper);
        page.append(annotationLayer);

        expect(hasPdfPageAnnotationVisualContent(page)).toBe(false);
    });
});
