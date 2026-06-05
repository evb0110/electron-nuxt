import {
    describe,
    expect,
    it,
} from 'vitest';
import { findAnnotationSummaryFromPoint } from '@app/composables/pdf/annotationCommentCrudHelpers';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IFakeRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

class FakeDocument {
    elementsAtPoint: FakeElement[] = [];

    elementsFromPoint() {
        return this.elementsAtPoint;
    }
}

class FakeElement {
    children: FakeElement[] = [];
    dataset: Record<string, string> = {};
    ownerDocument: FakeDocument;
    parentElement: FakeElement | null = null;

    constructor(
        private readonly className: string,
        private readonly rect: IFakeRect,
        ownerDocument = new FakeDocument(),
    ) {
        this.ownerDocument = ownerDocument;
    }

    append(child: FakeElement) {
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
    }

    closest(selector: string) {
        if (this.matches(selector)) {
            return this;
        }
        let current = this.parentElement;
        while (current) {
            if (current.matches(selector)) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    getAttribute(name: string) {
        return name === 'data-annotation-id'
            ? this.dataset.annotationId ?? null
            : null;
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
            return this.className === 'page_container';
        }
        if (selector === '.annotationLayer [data-annotation-id], .annotation-layer [data-annotation-id]') {
            return Boolean(this.dataset.annotationId) && this.hasAnnotationLayerAncestor();
        }
        return false;
    }

    querySelectorAll(selector: string) {
        const matches: FakeElement[] = [];
        const visit = (element: FakeElement) => {
            if (element.matches(selector)) {
                matches.push(element);
            }
            element.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }

    private hasAnnotationLayerAncestor() {
        let current = this.parentElement;
        while (current) {
            if (current.className === 'annotationLayer' || current.className === 'annotation-layer') {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }
}

function createSummary(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'ann',
        stableKey: overrides.stableKey ?? overrides.id ?? 'ann',
        sortIndex: null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: '',
        kindLabel: null,
        subtype: overrides.subtype ?? 'Underline',
        author: null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: null,
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'pdf',
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.1,
            width: 0.3,
            height: 0.05,
        },
    };
}

function createPage(document: FakeDocument) {
    const page = new FakeElement('page_container', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    }, document);
    page.dataset.page = '1';
    return page;
}

function toHTMLElement(element: FakeElement) {
    return element as never;
}

describe('findAnnotationSummaryFromPoint', () => {
    it('prefers the annotation layer element under the pointer', () => {
        const document = new FakeDocument();
        const page = createPage(document);
        const annotationLayer = new FakeElement('annotationLayer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        }, document);
        const older = new FakeElement('underlineAnnotation', {
            left: 100,
            top: 100,
            width: 300,
            height: 50,
        }, document);
        older.dataset.annotationId = 'older';
        const topmost = new FakeElement('underlineAnnotation', {
            left: 100,
            top: 100,
            width: 300,
            height: 50,
        }, document);
        topmost.dataset.annotationId = 'topmost';
        page.append(annotationLayer);
        annotationLayer.append(older);
        annotationLayer.append(topmost);
        document.elementsAtPoint = [topmost];

        const summary = findAnnotationSummaryFromPoint(
            toHTMLElement(page),
            150,
            120,
            1,
            [
                createSummary({
                    id: 'older',
                    stableKey: 'older',
                    annotationId: 'older',
                }),
                createSummary({
                    id: 'topmost',
                    stableKey: 'topmost',
                    annotationId: 'topmost',
                }),
            ],
            () => toHTMLElement(page),
        );

        expect(summary?.annotationId).toBe('topmost');
    });

    it('breaks identical marker-rect ties toward the most recently modified summary', () => {
        const document = new FakeDocument();
        const page = createPage(document);

        const summary = findAnnotationSummaryFromPoint(
            toHTMLElement(page),
            150,
            120,
            1,
            [
                createSummary({
                    id: 'older',
                    stableKey: 'older',
                    annotationId: 'older',
                    modifiedAt: 100,
                }),
                createSummary({
                    id: 'newer',
                    stableKey: 'newer',
                    annotationId: 'newer',
                    modifiedAt: 200,
                }),
            ],
            () => toHTMLElement(page),
        );

        expect(summary?.annotationId).toBe('newer');
    });
});
