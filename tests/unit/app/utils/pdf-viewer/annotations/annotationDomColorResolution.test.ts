import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveAnnotationCommentTextMarkupColor } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';
import { resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics';

interface IFakeRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

class FakeStyle {
    backgroundColor = '';
    borderBottomColor = '';
    borderBottomStyle = 'none';
    borderBottomWidth = '0px';
    borderTopColor = '';
    borderTopStyle = 'none';
    borderTopWidth = '0px';
    display = 'block';
    fill = '';
    opacity = '1';
    stroke = '';
    textDecorationColor = '';
    textDecorationLine = 'none';
    visibility = 'visible';
    private readonly properties = new Map<string, string>();

    getPropertyValue(name: string) {
        return this.properties.get(name) ?? '';
    }

    setProperty(name: string, value: string) {
        this.properties.set(name, value);
    }
}

class FakeDocument {
    elementsAtPoint: FakeElement[] = [];

    elementFromPoint() {
        return this.elementsAtPoint[0] ?? null;
    }

    elementsFromPoint() {
        return this.elementsAtPoint;
    }
}

class FakeElement {
    children: FakeElement[] = [];
    className: string;
    dataset: Record<string, string | undefined> = {};
    id = '';
    ownerDocument: FakeDocument;
    parentElement: FakeElement | null = null;
    style = new FakeStyle();
    tagName: string;
    private readonly attributes = new Map<string, string>();

    constructor(
        className: string,
        private readonly rect: IFakeRect,
        ownerDocument: FakeDocument,
        tagName = 'div',
    ) {
        this.className = className;
        this.ownerDocument = ownerDocument;
        this.tagName = tagName;
    }

    append(child: FakeElement) {
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
    }

    closest(selector: string) {
        return FakeElement.closestFrom(this, selector);
    }

    private static closestFrom(element: FakeElement, selector: string) {
        for (let current: FakeElement | null = element; current; current = current.parentElement) {
            if (current.matches(selector)) {
                return current;
            }
        }
        return null;
    }

    contains(element: FakeElement): boolean {
        return element === this || this.children.some(child => child.contains(element));
    }

    getAttribute(name: string) {
        if (name === 'class') {
            return this.className;
        }
        if (name === 'data-annotation-id') {
            return this.dataset.annotationId ?? null;
        }
        return this.attributes.get(name) ?? null;
    }

    getBoundingClientRect() {
        return {
            ...this.rect,
            bottom: this.rect.top + this.rect.height,
            right: this.rect.left + this.rect.width,
        } as DOMRect;
    }

    matches(selector: string) {
        if (selector === '.page_container') {
            return this.className.split(/\s+/).includes('page_container');
        }
        if (selector === '[data-annotation-id]') {
            return Boolean(this.dataset.annotationId);
        }
        if (selector === 'svg.highlight') {
            return this.tagName.toLowerCase() === 'svg'
                && this.className.split(/\s+/).includes('highlight');
        }
        if (selector === '[class*="pdf-markup-subtype"]') {
            return this.className.includes('pdf-markup-subtype');
        }
        return false;
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const descendants = this.getDescendants();
        if (selector === '[data-annotation-id]') {
            return descendants.filter(element => Boolean(element.dataset.annotationId));
        }
        if (selector.startsWith('.page_container')) {
            const pageMatch = /data-page="(?<pageNumber>\d+)"/.exec(selector);
            return descendants.filter(element => (
                element.className.split(/\s+/).includes('page_container')
                && (!pageMatch?.groups?.pageNumber || element.dataset.page === pageMatch.groups.pageNumber)
            ));
        }
        if (selector.includes('[class*="pdf-markup-subtype-draw"]')) {
            return descendants.filter(element => element.className.includes('pdf-markup-subtype-draw'));
        }
        if (selector.includes('svg.highlight') || selector.includes('section svg')) {
            return descendants.filter(element => (
                element.tagName.toLowerCase() === 'svg'
                && (
                    element.className.split(/\s+/).includes('highlight')
                    || element.className.includes('pdf-markup-subtype-draw-visual')
                )
            ));
        }
        if (selector === 'svg, path, rect, line, polyline, polygon, use, mark, u, s') {
            const visualTags = new Set([
                'svg',
                'path',
                'rect',
                'line',
                'polyline',
                'polygon',
                'use',
                'mark',
                'u',
                's',
            ]);
            return descendants.filter(element => visualTags.has(element.tagName.toLowerCase()));
        }
        return [];
    }

    setAttribute(name: string, value: string) {
        if (name === 'class') {
            this.className = value;
        } else if (name === 'data-annotation-id') {
            this.dataset.annotationId = value;
        }
        this.attributes.set(name, value);
    }

    private getDescendants(): FakeElement[] {
        return this.children.flatMap(child => [
            child,
            ...child.getDescendants(),
        ]);
    }
}

const asHtml = (element: FakeElement): HTMLElement & FakeElement => element as HTMLElement & FakeElement;

function createComment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'comment-1',
        stableKey: 'comment-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Marked text',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        },
        ...overrides,
    };
}

function createViewerFixture() {
    const ownerDocument = new FakeDocument();
    const container = new FakeElement('viewer', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    }, ownerDocument);
    const page = new FakeElement('page_container', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    }, ownerDocument);
    page.dataset.page = '1';
    container.append(page);
    return {
        container,
        ownerDocument,
        page,
    };
}

let originalGetComputedStyleDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
    originalGetComputedStyleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
    Object.defineProperty(globalThis, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => (element as Element & { style: FakeStyle }).style,
    });
});

afterEach(() => {
    if (originalGetComputedStyleDescriptor) {
        Object.defineProperty(globalThis, 'getComputedStyle', originalGetComputedStyleDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, 'getComputedStyle');
    }
});

describe('annotation text markup color resolution', () => {
    it('uses geometry-matched annotation elements when the PDF summary has no annotation id', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const renderedHighlight = new FakeElement('highlight textLayerHighlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        }, container.ownerDocument);
        renderedHighlight.dataset.annotationId = '77R0';
        renderedHighlight.style.setProperty('--pdf-markup-subtype-color', 'rgb(34, 197, 94)');
        page.append(renderedHighlight);

        const color = resolveAnnotationCommentTextMarkupColor(
            asHtml(container),
            createComment({ subtype: 'Highlight' }),
        );

        expect(color).toBe('#22c55e');
    });

    it('reports point visual-node diagnostics for rendered highlight paint inside an editor shell', () => {
        const {
            container,
            ownerDocument,
            page,
        } = createViewerFixture();
        const editor = new FakeElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        }, ownerDocument);
        editor.dataset.annotationId = '42R0';
        const paintedPath = new FakeElement('', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        }, ownerDocument, 'path');
        paintedPath.setAttribute('fill', '#bad3fc');
        editor.append(paintedPath);
        page.append(editor);
        ownerDocument.elementsAtPoint = [editor];

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            asHtml(container),
            createComment({
                annotationId: '42R0',
                subtype: 'Highlight',
            }),
            200,
            225,
        );

        expect(diagnostics).toMatchObject({
            annotationId: '42R0',
            color: '#bad3fc',
            pointElementCount: 1,
            source: 'point:visual-node',
            subtype: 'highlight',
        });
    });

    it('prefers the visible nearby underline stroke over a stale editor dataset color', () => {
        const {
            container,
            ownerDocument,
            page,
        } = createViewerFixture();
        const staleEditor = new FakeElement('highlightEditor pdf-markup-subtype-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        }, ownerDocument);
        staleEditor.dataset.annotationId = '88R0';
        staleEditor.dataset.markupSubtypeColor = '#22c55e';
        staleEditor.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        const visibleUnderline = new FakeElement(
            'pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline',
            {
                left: 100,
                top: 222,
                width: 200,
                height: 4,
            },
            ownerDocument,
            'svg',
        );
        visibleUnderline.setAttribute('stroke', '#ef4444');
        page.append(staleEditor);
        page.append(visibleUnderline);
        ownerDocument.elementsAtPoint = [staleEditor];

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            asHtml(container),
            createComment({
                annotationId: '88R0',
                color: '#22c55e',
                subtype: 'Underline',
            }),
            200,
            224,
        );

        expect(diagnostics).toMatchObject({
            color: '#ef4444',
            source: 'point:nearby-element',
            subtype: 'underline',
        });
    });
});
