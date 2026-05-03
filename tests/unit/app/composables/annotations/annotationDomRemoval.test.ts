import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { removeAnnotationCommentDom } from '@app/composables/pdf/annotations/annotationDomRemoval';
import { refreshHighlightCompositeOverlay } from '@app/composables/pdf/pdfHighlightCompositeOverlay';

vi.mock('@app/composables/pdf/pdfHighlightCompositeOverlay', () => ({ refreshHighlightCompositeOverlay: vi.fn() }));

interface IFakeRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

class FakeClassList {
    private readonly classes: Set<string>;

    constructor(className: string) {
        this.classes = new Set(className.split(/\s+/).filter(Boolean));
    }

    contains(className: string) {
        return this.classes.has(className);
    }
}

class FakeElement {
    dataset: { annotationId?: string; } = {};
    classList: FakeClassList;
    className: string;
    removed = false;
    ariaControls: string | null = null;
    pageContainer: FakePage | null = null;
    parentAnnotation: FakeElement | null = null;

    constructor(className: string, private readonly rect: IFakeRect) {
        this.className = className;
        this.classList = new FakeClassList(className);
    }

    getAttribute(name: string) {
        if (name === 'data-annotation-id') {
            return this.dataset.annotationId ?? null;
        }
        if (name === 'aria-controls') {
            return this.ariaControls;
        }
        return null;
    }

    getBoundingClientRect() {
        return this.rect as DOMRect;
    }

    closest(selector: string): FakePage | FakeElement | null {
        if (selector === '.page_container') {
            return this.pageContainer;
        }
        if (selector === '[data-annotation-id]') {
            return this.parentAnnotation;
        }
        return null;
    }

    remove() {
        this.removed = true;
    }
}

class FakePage extends FakeElement {
    svgs: FakeElement[] = [];

    querySelectorAll(selector: string) {
        return selector === '.page_canvas svg.highlight:not(.free), .canvasWrapper svg.highlight:not(.free)'
            ? this.svgs
            : [];
    }
}

class FakeContainer extends FakeElement {
    annotations: FakeElement[] = [];
    pages: FakePage[] = [];
    popups: FakeElement[] = [];

    querySelectorAll(selector: string) {
        if (selector === '[data-annotation-id]') {
            return this.annotations;
        }
        if (selector === '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]') {
            return this.popups;
        }
        return [];
    }

    querySelector(selector: string) {
        const pageMatch = selector.match(/^\.page_container\[data-page="(\d+)"\]$/);
        if (!pageMatch?.[1]) {
            return null;
        }
        return this.pages[Number(pageMatch[1]) - 1] ?? null;
    }
}

function toHTMLElement(element: FakeContainer): HTMLElement {
    return element as never;
}

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? '12R0',
        stableKey: overrides.stableKey ?? 'ann:0:12R',
        sortIndex: overrides.sortIndex ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? '',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'Highlight',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? '12R0',
        source: overrides.source ?? 'pdf',
        hasNote: overrides.hasNote ?? false,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        },
    };
}

describe('removeAnnotationCommentDom', () => {
    it('removes annotation layer elements using normalized PDF.js annotation ids', () => {
        const container = new FakeContainer('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = new FakeElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        annotation.dataset.annotationId = '12R';
        const popup = new FakeElement('popup', {
            left: 120,
            top: 220,
            width: 20,
            height: 20,
        });
        popup.dataset.annotationId = 'popup-12R';
        popup.ariaControls = 'pdfjs_internal_id_12R';
        popup.parentAnnotation = annotation;
        container.annotations = [annotation];
        container.popups = [popup];

        removeAnnotationCommentDom(toHTMLElement(container), createComment());

        expect(annotation.removed).toBe(true);
        expect(popup.removed).toBe(true);
    });

    it('removes the matching draw-layer highlight visual and refreshes the composite overlay', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        const container = new FakeContainer('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = new FakePage('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = new FakeElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const matchingHighlight = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const distantHighlight = new FakeElement('highlight', {
            left: 600,
            top: 600,
            width: 150,
            height: 40,
        });
        annotation.dataset.annotationId = '12R';
        annotation.pageContainer = page;
        page.svgs = [
            matchingHighlight,
            distantHighlight,
        ];
        container.annotations = [annotation];
        container.pages = [page];

        removeAnnotationCommentDom(toHTMLElement(container), createComment());

        expect(matchingHighlight.removed).toBe(true);
        expect(distantHighlight.removed).toBe(false);
        expect(refresh).toHaveBeenCalledWith(page);
    });
});
