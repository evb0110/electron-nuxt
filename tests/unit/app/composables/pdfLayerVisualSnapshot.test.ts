import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    hasPdfPageAnnotationVisualContent,
    hasPdfPageAnnotationVisualContentForSnapshotRelease,
    PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS,
    PDF_LAYER_VISUAL_SNAPSHOT_CLASS,
    PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS,
    preservePdfDrawLayerVisualSnapshot,
    preservePdfLayerVisualSnapshot,
    preservePdfPageAnnotationVisualSnapshot,
} from '@app/composables/pdf/pdfLayerVisualSnapshot';

class FakeClassList {
    readonly names = new Set<string>();

    add(...names: string[]) {
        names.forEach(name => this.names.add(name));
    }

    remove(...names: string[]) {
        names.forEach(name => this.names.delete(name));
    }

    contains(name: string) {
        return this.names.has(name);
    }
}

class FakeElement {
    readonly tagName: string;
    readonly classList = new FakeClassList();
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    readonly style = { visibility: '' };
    parentElement: FakeElement | null = null;
    hidden = false;
    inert = false;
    tabIndex = 0;

    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
    }

    get childElementCount() {
        return this.children.length;
    }

    get lastElementChild(): FakeElement | null {
        return this.children.at(-1) ?? null;
    }

    append(...children: FakeElement[]) {
        children.forEach((child) => {
            child.parentElement = this;
            this.children.push(child);
        });
    }

    remove() {
        const siblings = this.parentElement?.children;
        if (!siblings) {
            return;
        }
        const index = siblings.indexOf(this);
        if (index >= 0) {
            siblings.splice(index, 1);
        }
        this.parentElement = null;
    }

    cloneNode(deep?: boolean) {
        const clone = new FakeElement(this.tagName);
        clone.hidden = this.hidden;
        clone.inert = this.inert;
        clone.tabIndex = this.tabIndex;
        clone.style.visibility = this.style.visibility;
        this.classList.names.forEach(name => clone.classList.add(name));
        this.attributes.forEach((value, key) => clone.attributes.set(key, value));
        if (deep) {
            this.children.forEach(child => clone.append(child.cloneNode(true)));
        }
        return clone;
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    getAttributeNames() {
        return Array.from(this.attributes.keys());
    }

    getBoundingClientRect() {
        return {
            bottom: 20,
            height: 20,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
            x: 0,
            y: 0,
        };
    }

    closest(selector: string) {
        if (!selector.startsWith('.')) {
            return null;
        }
        const className = selector.slice(1);

        if (this.classList.contains(className)) {
            return this;
        }

        let parent = this.parentElement;
        while (parent) {
            if (parent.classList.contains(className)) {
                return parent;
            }
            parent = parent.parentElement;
        }
        return null;
    }

    querySelector(selector: string) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const descendants = this.getDescendants();
        if (selector === '*') {
            return descendants;
        }
        if (selector === 'a, button, input, select, textarea, [tabindex]') {
            return descendants.filter(element => (
                [
                    'A',
                    'BUTTON',
                    'INPUT',
                    'SELECT',
                    'TEXTAREA',
                ].includes(element.tagName)
                || element.attributes.has('tabindex')
            ));
        }
        const drawLayerVisualSelector = [
            ':scope > svg.highlight',
            ':scope > svg.highlightOutline',
            ':scope > svg.draw',
            ':scope > svg.pdf-highlight-composite-overlay',
        ].join(', ');
        if (selector === drawLayerVisualSelector) {
            return this.children.filter(element => (
                element.tagName === 'SVG'
                && (
                    element.classList.contains('highlight')
                    || element.classList.contains('highlightOutline')
                    || element.classList.contains('draw')
                    || element.classList.contains('pdf-highlight-composite-overlay')
                )
            ));
        }
        if (selector === '.page_canvas, .canvasWrapper') {
            return descendants.filter(element => (
                element.classList.contains('page_canvas')
                || element.classList.contains('canvasWrapper')
            ));
        }
        if (selector === '.annotation-layer, .annotationLayer') {
            return descendants.filter(element => (
                element.classList.contains('annotation-layer')
                || element.classList.contains('annotationLayer')
            ));
        }
        if (selector === '.annotation-editor-layer, .annotationEditorLayer') {
            return descendants.filter(element => (
                element.classList.contains('annotation-editor-layer')
                || element.classList.contains('annotationEditorLayer')
            ));
        }
        const annotationVisualSelector = [
            '.editorAnnotation',
            '.highlightAnnotation',
            '.underlineAnnotation',
            '.strikeoutAnnotation',
            '.squigglyAnnotation',
            '[data-annotation-id]',
        ].join(', ');
        if (selector === annotationVisualSelector) {
            return descendants.filter(element => (
                element.classList.contains('editorAnnotation')
                || element.classList.contains('highlightAnnotation')
                || element.classList.contains('underlineAnnotation')
                || element.classList.contains('strikeoutAnnotation')
                || element.classList.contains('squigglyAnnotation')
                || element.attributes.has('data-annotation-id')
            ));
        }
        const textMarkupEditorSelector = [
            '.highlightEditor',
            '[role="mark"]',
            '[class*="pdf-markup-subtype"]',
        ].join(', ');
        if (selector === textMarkupEditorSelector) {
            return descendants.filter(element => (
                element.classList.contains('highlightEditor')
                || element.getAttribute('role') === 'mark'
                || Array.from(element.classList.names).some(name => name.includes('pdf-markup-subtype'))
            ));
        }
        if (selector.startsWith('.')) {
            const className = selector.slice(1);
            return descendants.filter(element => element.classList.contains(className));
        }
        return descendants.filter(element => element.tagName.toLowerCase() === selector);
    }

    private getDescendants() {
        const descendants: FakeElement[] = [];
        const visit = (element: FakeElement) => {
            element.children.forEach((child) => {
                descendants.push(child);
                visit(child);
            });
        };
        visit(this);
        return descendants;
    }
}

function asElement(element: FakeElement) {
    return element as never;
}

function createSvg(className: string) {
    const svg = new FakeElement('svg');
    svg.classList.add(className);
    return svg;
}

describe('pdfLayerVisualSnapshot', () => {
    beforeEach(() => {
        vi.stubGlobal('HTMLElement', FakeElement);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps a non-interactive layer clone until released', () => {
        const page = new FakeElement();
        const layer = new FakeElement();
        const button = new FakeElement('button');
        layer.classList.add('annotation-editor-layer');
        button.setAttribute('id', 'editor-button');
        layer.append(button);
        page.append(layer);

        const release = preservePdfLayerVisualSnapshot(asElement(layer));
        const snapshot = page.lastElementChild;

        expect(release).toBeTypeOf('function');
        expect(snapshot).not.toBe(layer);
        expect(snapshot?.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_CLASS)).toBe(true);
        expect(snapshot?.getAttribute('aria-hidden')).toBe('true');
        expect(snapshot?.querySelector('button')?.tabIndex).toBe(-1);
        expect(layer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(true);
        expect(button.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);
        expect(button.style.visibility).toBe('hidden');
        expect(snapshot?.querySelector('button')?.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);

        release?.();

        expect(page.children).toHaveLength(1);
        expect(layer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(false);
        expect(button.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(button.style.visibility).toBe('');
    });

    it('clones draw-layer SVGs that live under the canvas wrapper', () => {
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const canvas = new FakeElement('canvas');
        const highlight = createSvg('highlight');
        const outline = createSvg('highlightOutline');
        const composite = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(
            canvas,
            highlight,
            outline,
            composite,
        );

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));
        const snapshots = canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(3);
        expect(canvasHost.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(true);
        expect(snapshots.map(node => node.tagName.toLowerCase())).toEqual([
            'svg',
            'svg',
            'svg',
        ]);
        expect(highlight.style.visibility).toBe('hidden');
        expect(outline.style.visibility).toBe('hidden');
        expect(composite.style.visibility).toBe('hidden');
        expect(highlight.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);
        expect(outline.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);
        expect(composite.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);
        expect(snapshots.every(snapshot => snapshot.style.visibility === '')).toBe(true);

        release?.();

        expect(highlight.style.visibility).toBe('');
        expect(outline.style.visibility).toBe('');
        expect(composite.style.visibility).toBe('');
        expect(canvasHost.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(false);
        expect(highlight.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(outline.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(composite.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(0);
    });

    it('allows snapshot releases to be called more than once', () => {
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const highlight = createSvg('highlight');
        canvasHost.append(highlight);

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));

        expect(release).toBeTypeOf('function');

        release?.();
        release?.();

        expect(highlight.style.visibility).toBe('');
        expect(highlight.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(canvasHost.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(false);
        expect(canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(0);
    });

    it('does not clone hidden composite source highlights', () => {
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const hiddenCompositeSource = createSvg('highlight');
        hiddenCompositeSource.classList.add('pdf-highlight-composite-source');
        const visibleComposite = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(hiddenCompositeSource, visibleComposite);

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));
        const snapshots = canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.classList.contains('pdf-highlight-composite-overlay')).toBe(true);
    });

    it('suppresses fresh replacement draw visuals while a snapshot is active but allows release detection', () => {
        const page = new FakeElement();
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const oldHighlight = createSvg('highlight');
        canvasHost.append(oldHighlight);
        page.append(canvasHost);

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));
        const freshOverlay = createSvg('pdf-highlight-composite-overlay');
        canvasHost.append(freshOverlay);

        expect(release).toBeTypeOf('function');
        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(false);
        expect(hasPdfPageAnnotationVisualContentForSnapshotRelease(asElement(page))).toBe(true);

        release?.();

        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(true);
    });

    it('rewrites cloned SVG ids so snapshot hrefs stay self-contained', () => {
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const highlight = createSvg('highlight');
        const defs = new FakeElement('defs');
        const path = new FakeElement('path');
        const use = new FakeElement('use');
        path.setAttribute('id', 'path_1');
        use.setAttribute('href', '#path_1');
        use.setAttribute('mask', 'url(#mask_1)');
        const mask = new FakeElement('mask');
        mask.setAttribute('id', 'mask_1');
        defs.append(path, mask);
        highlight.append(defs, use);
        canvasHost.append(highlight);

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));
        const snapshot = canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)[0];
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
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const liveHighlight = createSvg('highlight');
        const oldSnapshot = createSvg('highlight');
        oldSnapshot.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_CLASS);
        canvasHost.append(liveHighlight, oldSnapshot);

        const release = preservePdfDrawLayerVisualSnapshot(asElement(canvasHost));
        const snapshots = canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(2);

        release?.();

        expect(canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(1);
    });

    it('does not stack page handoff snapshots while one is already active', () => {
        const page = new FakeElement();
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        const oldSnapshot = createSvg('highlight');
        oldSnapshot.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_CLASS);
        const liveHighlight = createSvg('highlight');
        canvasHost.append(oldSnapshot, liveHighlight);
        page.append(canvasHost);

        const release = preservePdfPageAnnotationVisualSnapshot(
            asElement(page),
            null,
        );

        expect(release).toBeNull();
        expect(canvasHost.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(1);
    });

    it('preserves annotation, editor, and draw-layer visuals for a page handoff', () => {
        const page = new FakeElement();
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        canvasHost.append(createSvg('highlight'));
        const annotationLayer = new FakeElement();
        annotationLayer.classList.add('annotation-layer');
        annotationLayer.append(new FakeElement());
        const editorLayer = new FakeElement();
        editorLayer.classList.add('annotation-editor-layer');
        editorLayer.append(new FakeElement());
        page.append(
            canvasHost,
            annotationLayer,
            editorLayer,
        );

        const release = preservePdfPageAnnotationVisualSnapshot(
            asElement(page),
            asElement(editorLayer),
        );

        expect(release).toBeTypeOf('function');
        expect(page.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(3);

        release?.();

        expect(page.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(0);
    });

    it('uses draw-layer snapshots instead of cloning text-markup editor rectangles', () => {
        const page = new FakeElement();
        const canvasHost = new FakeElement();
        canvasHost.classList.add('page_canvas', 'canvasWrapper');
        canvasHost.append(createSvg('highlight'));
        const annotationLayer = new FakeElement();
        annotationLayer.classList.add('annotation-layer');
        const editorReplica = new FakeElement();
        editorReplica.classList.add('editorAnnotation');
        annotationLayer.append(editorReplica);
        const editorLayer = new FakeElement();
        editorLayer.classList.add('annotation-editor-layer');
        const highlightEditor = new FakeElement();
        highlightEditor.classList.add('highlightEditor');
        editorLayer.append(highlightEditor);
        page.append(
            canvasHost,
            annotationLayer,
            editorLayer,
        );

        const release = preservePdfPageAnnotationVisualSnapshot(
            asElement(page),
            asElement(editorLayer),
        );
        const snapshots = page.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`);

        expect(release).toBeTypeOf('function');
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.tagName).toBe('SVG');
        expect(annotationLayer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(true);
        expect(editorLayer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(true);
        expect(editorReplica.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);
        expect(highlightEditor.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(true);

        release?.();

        expect(page.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)).toHaveLength(0);
        expect(annotationLayer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(false);
        expect(editorLayer.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)).toBe(false);
        expect(editorReplica.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
        expect(highlightEditor.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)).toBe(false);
    });

    it('detects live page annotation visuals but ignores snapshot-only content', () => {
        const page = new FakeElement();
        const annotationLayer = new FakeElement();
        annotationLayer.classList.add('annotation-layer');
        const highlight = new FakeElement();
        highlight.classList.add('highlightAnnotation');
        annotationLayer.append(highlight);
        page.append(annotationLayer);

        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(true);

        highlight.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);

        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(false);

        highlight.classList.remove(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);
        highlight.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_CLASS);

        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(false);
    });

    it('ignores visual descendants while their snapshot source parent is hidden', () => {
        const page = new FakeElement();
        const annotationLayer = new FakeElement();
        annotationLayer.classList.add('annotation-layer');
        const sourceWrapper = new FakeElement();
        sourceWrapper.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);
        const highlight = new FakeElement();
        highlight.classList.add('highlightAnnotation');
        sourceWrapper.append(highlight);
        annotationLayer.append(sourceWrapper);
        page.append(annotationLayer);

        expect(hasPdfPageAnnotationVisualContent(asElement(page))).toBe(false);
    });
});
