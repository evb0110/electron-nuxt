import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    applyAnnotationCommentTextMarkupColor,
    removeAnnotationCommentDom,
    resolveAnnotationCommentTextMarkupColor,
    resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics,
    resolveCommentWithRenderedTextMarkupColorAtPoint,
} from '@app/composables/pdf/annotations/annotationDomRemoval';
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

    add(...classNames: string[]) {
        classNames.forEach(className => this.classes.add(className));
    }

    contains(className: string) {
        return this.classes.has(className);
    }
}

class FakeStyle {
    background = '';
    backgroundColor = '';
    borderBottomColor = '';
    borderBottomStyle = 'none';
    borderBottomWidth = '0px';
    borderColor = '';
    borderTopColor = '';
    borderTopStyle = 'none';
    borderTopWidth = '0px';
    color = '';
    display = 'block';
    fill = '';
    opacity = '1';
    stroke = '';
    textDecorationColor = '';
    textDecorationLine = 'none';
    visibility = 'visible';
    private readonly properties = new Map<string, string>();

    setProperty(name: string, value: string) {
        this.properties.set(name, value);
        this.setNamedProperty(name, value);
    }

    removeProperty(name: string) {
        this.properties.delete(name);
        this.setNamedProperty(name, '');
    }

    getPropertyValue(name: string) {
        return this.properties.get(name) ?? this.getNamedProperty(name);
    }

    private setNamedProperty(name: string, value: string) {
        if (name === 'background') {
            this.background = value;
        } else if (name === 'background-color') {
            this.backgroundColor = value;
        } else if (name === 'fill') {
            this.fill = value;
        } else if (name === 'opacity') {
            this.opacity = value;
        } else if (name === 'stroke') {
            this.stroke = value;
        } else if (name === 'visibility') {
            this.visibility = value;
        }
    }

    private getNamedProperty(name: string) {
        if (name === 'background') {
            return this.background;
        }
        if (name === 'background-color') {
            return this.backgroundColor;
        }
        if (name === 'fill') {
            return this.fill;
        }
        if (name === 'stroke') {
            return this.stroke;
        }
        if (name === 'opacity') {
            return this.opacity;
        }
        if (name === 'visibility') {
            return this.visibility;
        }
        return '';
    }
}

class FakeDocument {
    elementsAtPoint: FakeElement[] = [];

    createElementNS(_namespace: string, tagName: string) {
        const element = new FakeElement(tagName, {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        });
        element.ownerDocument = this;
        return element;
    }

    elementFromPoint() {
        return this.elementsAtPoint[0] ?? null;
    }

    elementsFromPoint() {
        return this.elementsAtPoint;
    }
}

class FakeElement {
    dataset: {
        annotationId?: string;
        markupSubtypeColor?: string;
    } = {};
    classList: FakeClassList;
    className: string;
    children: FakeElement[] = [];
    id = '';
    ownerDocument: FakeDocument = new FakeDocument();
    parentElement: FakeElement | null = null;
    removed = false;
    ariaControls: string | null = null;
    pageContainer: FakePage | null = null;
    parentAnnotation: FakeElement | null = null;
    style = new FakeStyle();
    tagName: string;
    private readonly attributes = new Map<string, string>();

    constructor(className: string, private readonly rect: IFakeRect) {
        this.className = className;
        this.classList = new FakeClassList(className);
        this.tagName = className === 'highlight' ? 'svg' : className;
    }

    getAttribute(name: string) {
        if (name === 'data-annotation-id') {
            return this.dataset.annotationId ?? null;
        }
        if (name === 'aria-controls') {
            return this.ariaControls;
        }
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name: string, value: string) {
        if (name === 'class') {
            this.className = value;
            this.classList = new FakeClassList(value);
        }
        this.attributes.set(name, value);
    }

    getBoundingClientRect() {
        return {
            ...this.rect,
            bottom: this.rect.top + this.rect.height,
            right: this.rect.left + this.rect.width,
        } as DOMRect;
    }

    contains(element: FakeElement): boolean {
        if (element === this) {
            return true;
        }
        return this.children.some(child => child.contains(element));
    }

    append(child: FakeElement) {
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
    }

    closest(selector: string): FakePage | FakeElement | null {
        if (selector === '.page_container') {
            return this.pageContainer;
        }
        if (selector === '[data-annotation-id]') {
            if (this.dataset.annotationId) {
                return this;
            }
            return this.parentAnnotation;
        }
        if (selector === 'svg.highlight') {
            return this.matches(selector) ? this : null;
        }
        if (selector === '[class*="pdf-markup-subtype"]') {
            return this.className.includes('pdf-markup-subtype') ? this : null;
        }
        return null;
    }

    matches(selector: string) {
        if (selector === '[data-annotation-id]') {
            return Boolean(this.dataset.annotationId);
        }
        if (selector === 'svg.highlight') {
            return this.tagName.toLowerCase() === 'svg' && this.classList.contains('highlight');
        }
        if (selector === '[class*="pdf-markup-subtype"]') {
            return this.className.includes('pdf-markup-subtype');
        }
        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }
        return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    remove() {
        this.removed = true;
        const siblingIndex = this.parentElement?.children.indexOf(this) ?? -1;
        if (siblingIndex >= 0) {
            this.parentElement?.children.splice(siblingIndex, 1);
        }
    }

    private matchesQuerySelector(selector: string) {
        const selectorParts = selector.split(',').map(part => part.trim());
        return selectorParts.some((part) => {
            if (part === '[data-annotation-id]') {
                return Boolean(this.dataset.annotationId);
            }
            if (part === '[class*="pdf-markup-subtype-draw"]' || part === '[class*="pdf-markup-subtype-draw"] *') {
                return this.className.includes('pdf-markup-subtype-draw');
            }
            if (part === 'canvas' || part === 'svg' || part === 'path' || part === 'rect' || part === 'line' || part === 'polyline' || part === 'polygon' || part === 'use') {
                return this.tagName.toLowerCase() === part;
            }
            if (part === 'svg.highlight:not(.free)' || part === 'svg.highlight:not(.free) *') {
                return this.tagName.toLowerCase() === 'svg' && this.classList.contains('highlight');
            }
            if (part === 'mark' || part === 'u' || part === 's') {
                return this.tagName.toLowerCase() === part;
            }
            return false;
        });
    }

    querySelectorAll(selector: string) {
        const matches: FakeElement[] = [];
        const visit = (element: FakeElement) => {
            if (element.matchesQuerySelector(selector)) {
                matches.push(element);
            }
            element.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }
}

class FakePage extends FakeElement {
    annotations: FakeElement[] = [];
    svgs: FakeElement[] = [];

    override querySelectorAll(selector: string) {
        if (selector.includes('svg.highlight')) {
            return this.svgs;
        }
        if (selector === '[data-annotation-id]') {
            return this.annotations;
        }
        const ownMatches = super.querySelectorAll(selector);
        if (selector === 'canvas') {
            return ownMatches;
        }
        if (selector.includes('svg') || selector.includes('path') || selector.includes('line')) {
            return ownMatches;
        }
        return [];
    }
}

class FakeCanvas extends FakeElement {
    height: number;
    putImageDataCalls = 0;
    width: number;
    private readonly pixelData: Uint8ClampedArray;

    constructor(rect: IFakeRect, pixelData: Uint8ClampedArray) {
        super('canvas', rect);
        this.width = rect.width;
        this.height = rect.height;
        this.pixelData = pixelData;
    }

    getContext(type: string) {
        if (type !== '2d') {
            return null;
        }
        return {
            getImageData: vi.fn(() => ({
                data: this.pixelData,
                height: this.height,
                width: this.width,
            })),
            putImageData: vi.fn(() => {
                this.putImageDataCalls += 1;
            }),
        };
    }
}

class FakeContainer extends FakeElement {
    annotations: FakeElement[] = [];
    pages: FakePage[] = [];
    popups: FakeElement[] = [];

    override querySelectorAll(selector: string) {
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

const originalGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
    if (originalGetComputedStyle) {
        globalThis.getComputedStyle = originalGetComputedStyle;
        return;
    }
    Reflect.deleteProperty(globalThis, 'getComputedStyle');
});

function installFakeComputedStyle() {
    globalThis.getComputedStyle = ((element: FakeElement) => element.style) as never;
}

function connectPage(container: FakeContainer, page: FakePage) {
    page.ownerDocument = container.ownerDocument;
    page.parentElement = container;
    container.children.push(page);
    container.pages = [page];
}

function connectToPage(page: FakePage, element: FakeElement) {
    element.pageContainer = page;
    element.ownerDocument = page.ownerDocument;
    element.parentElement = page;
    page.children.push(element);
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
        annotationId: 'annotationId' in overrides ? (overrides.annotationId ?? null) : '12R0',
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

    it('removes text markup visuals by geometry when no annotation id is available', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
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
        page.svgs = [
            matchingHighlight,
            distantHighlight,
        ];
        container.pages = [page];

        removeAnnotationCommentDom(toHTMLElement(container), createComment({
            annotationId: null,
            subtype: 'Highlight',
        }));

        expect(matchingHighlight.removed).toBe(true);
        expect(distantHighlight.removed).toBe(false);
        expect(refresh).toHaveBeenCalledWith(page);
    });
});

describe('applyAnnotationCommentTextMarkupColor', () => {
    it.each([
        {
            expectedAttribute: 'fill',
            initialAttribute: '#ffd400',
            subtype: 'Highlight',
        },
        {
            expectedAttribute: 'stroke',
            initialAttribute: '#22c55e',
            subtype: 'Underline',
        },
        {
            expectedAttribute: 'stroke',
            initialAttribute: '#06b6d4',
            subtype: 'StrikeOut',
        },
    ])(
        'recolors visible %s markup immediately without waiting for save',
        ({
            expectedAttribute,
            initialAttribute,
            subtype,
        }) => {
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
            connectPage(container, page);
            const matchingMarkup = new FakeElement('highlight', {
                left: 100,
                top: subtype === 'Highlight' ? 200 : 220,
                width: 200,
                height: subtype === 'Highlight' ? 50 : 3,
            });
            matchingMarkup.setAttribute(expectedAttribute, initialAttribute);
            page.svgs = [matchingMarkup];

            const didUpdate = applyAnnotationCommentTextMarkupColor(
                toHTMLElement(container),
                createComment({ subtype }),
                '#ec4899',
            );

            expect(didUpdate).toBe(true);
            expect(matchingMarkup.getAttribute(expectedAttribute)).toBe('#ec4899');
        },
    );

    it('recolors canvas-backed materialized text markup without a page reload', () => {
        const container = new FakeContainer('viewer', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        const page = new FakePage('page_container', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        connectPage(container, page);
        const pixels = new Uint8ClampedArray([
            255,
            230,
            80,
            255,
            255,
            255,
            255,
            255,
            0,
            0,
            0,
            255,
            255,
            230,
            80,
            255,
        ]);
        const canvas = new FakeCanvas({
            left: 0,
            top: 0,
            width: 2,
            height: 2,
        }, pixels);
        connectToPage(page, canvas);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Highlight',
                markerRect: {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(true);
        expect(canvas.putImageDataCalls).toBe(1);
        expect(Array.from(pixels)).toEqual([
            236,
            72,
            153,
            255,
            255,
            255,
            255,
            255,
            0,
            0,
            0,
            255,
            236,
            72,
            153,
            255,
        ]);
    });

    it('does not recolor overlapping highlight fill when repainting canvas-backed underline', () => {
        const container = new FakeContainer('viewer', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        const page = new FakePage('page_container', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        connectPage(container, page);
        const pixels = new Uint8ClampedArray([
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            239,
            68,
            68,
            255,
            239,
            68,
            68,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
        ]);
        const canvas = new FakeCanvas({
            left: 0,
            top: 0,
            width: 2,
            height: 4,
        }, pixels);
        connectToPage(page, canvas);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                },
            }),
            '#22c55e',
            { sourceColor: '#ef4444' },
        );

        expect(didUpdate).toBe(true);
        expect(Array.from(pixels)).toEqual([
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            34,
            197,
            94,
            255,
            34,
            197,
            94,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
        ]);
    });

    it('recolors the matching draw-layer highlight instead of stacking annotation-layer background', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
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
        annotation.dataset.annotationId = 'unmatched-id';
        annotation.pageContainer = page;
        annotation.style.backgroundColor = 'rgb(255, 255, 0)';

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
        matchingHighlight.setAttribute('fill', '#fff066');
        distantHighlight.setAttribute('fill', '#fff066');
        page.svgs = [
            matchingHighlight,
            distantHighlight,
        ];
        page.annotations = [annotation];
        container.pages = [page];

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment(),
            '#22c55e',
        );

        expect(didUpdate).toBe(true);
        expect(annotation.style.backgroundColor).toBe('');
        expect(matchingHighlight.getAttribute('fill')).toBe('#22c55e');
        expect(matchingHighlight.style.getPropertyValue('fill')).toBe('#22c55e');
        expect(distantHighlight.getAttribute('fill')).toBe('#fff066');
        expect(refresh).toHaveBeenCalledWith(page);
    });

    it('recolors thin underline visuals matched inside the text markup rect', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
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
        const matchingUnderline = new FakeElement('highlight', {
            left: 120,
            top: 360,
            width: 350,
            height: 3,
        });
        const distantUnderline = new FakeElement('highlight', {
            left: 120,
            top: 620,
            width: 350,
            height: 3,
        });
        matchingUnderline.setAttribute('stroke', '#06b6d4');
        distantUnderline.setAttribute('stroke', '#06b6d4');
        page.svgs = [
            matchingUnderline,
            distantUnderline,
        ];
        container.pages = [page];

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.2,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(true);
        expect(matchingUnderline.getAttribute('stroke')).toBe('#ec4899');
        expect(distantUnderline.getAttribute('stroke')).toBe('#06b6d4');
        expect(refresh).toHaveBeenCalledWith(page);
    });

    it('does not recolor non-highlight transparent rectangle outlines', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
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
        connectPage(container, page);
        const editorOutlineSvg = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        const outlineRect = new FakeElement('rect', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        outlineRect.setAttribute('fill', 'none');
        outlineRect.setAttribute('stroke', '#111827');
        editorOutlineSvg.append(outlineRect);
        page.svgs = [editorOutlineSvg];

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.08,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(false);
        expect(outlineRect.getAttribute('stroke')).toBe('#111827');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('suppresses the base highlight fill when recoloring underline markup', () => {
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
        connectPage(container, page);
        const baseHighlightSvg = new FakeElement('highlight pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightSvg.setAttribute('fill', '#ef4444');
        const baseHighlightUse = new FakeElement('use', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightUse.setAttribute('fill', '#ef4444');
        baseHighlightSvg.append(baseHighlightUse);
        const baseHighlightPath = new FakeElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        baseHighlightPath.setAttribute('fill', 'none');
        baseHighlightPath.setAttribute('stroke', '#ef4444');
        baseHighlightSvg.append(baseHighlightPath);
        const underlineVisual = new FakeElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        underlineVisual.tagName = 'svg';
        const underlinePath = new FakeElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        underlinePath.setAttribute('fill', 'none');
        underlinePath.setAttribute('stroke', '#ef4444');
        underlineVisual.append(underlinePath);
        page.svgs = [
            baseHighlightSvg,
            underlineVisual,
        ];

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.18,
                },
            }),
            '#22c55e',
        );

        expect(didUpdate).toBe(true);
        expect(baseHighlightSvg.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightUse.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightSvg.getAttribute('stroke')).toBe('transparent');
        expect(baseHighlightPath.getAttribute('stroke')).toBe('transparent');
        expect(underlinePath.getAttribute('stroke')).toBe('#22c55e');
    });

    it('suppresses unclassified PDF.js highlight geometry when recoloring underline markup', () => {
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
        connectPage(container, page);
        const baseHighlightSvg = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightSvg.setAttribute('fill', '#ef4444');
        const baseHighlightPath = new FakeElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        baseHighlightPath.setAttribute('fill', 'none');
        baseHighlightPath.setAttribute('stroke', '#ef4444');
        baseHighlightSvg.append(baseHighlightPath);
        const underlineVisual = new FakeElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        underlineVisual.tagName = 'svg';
        const underlinePath = new FakeElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        underlinePath.setAttribute('fill', 'none');
        underlinePath.setAttribute('stroke', '#ef4444');
        underlineVisual.append(underlinePath);
        page.svgs = [
            baseHighlightSvg,
            underlineVisual,
        ];

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.18,
                },
            }),
            '#3b82f6',
        );

        expect(didUpdate).toBe(true);
        expect(baseHighlightSvg.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightSvg.getAttribute('stroke')).toBe('transparent');
        expect(baseHighlightPath.getAttribute('stroke')).toBe('transparent');
        expect(underlinePath.getAttribute('stroke')).toBe('#3b82f6');
    });

    it('updates decorated annotation-layer markup without painting stale annotation box borders', () => {
        installFakeComputedStyle();
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
        const staleAnnotationNode = new FakeElement('annotationLayerItem underlineAnnotation', {
            left: 100,
            top: 200,
            width: 400,
            height: 200,
        });
        staleAnnotationNode.dataset.annotationId = '12R0';
        staleAnnotationNode.style.textDecorationLine = 'underline';
        page.annotations = [staleAnnotationNode];
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.2,
                },
            }),
            '#ef4444',
        );

        expect(didUpdate).toBe(true);
        expect(staleAnnotationNode.style.textDecorationColor).toBe('#ef4444');
        expect(staleAnnotationNode.style.borderColor).toBe('');
        expect(staleAnnotationNode.style.color).toBe('');
    });

    it('does not synthesize duplicate underline overlays when no visible visual can be recolored', () => {
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
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#3b82f6',
        );

        expect(didUpdate).toBe(false);
    });
});

describe('resolveAnnotationCommentTextMarkupColor', () => {
    it('reads highlight SVG paint instead of inherited black editor fill', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);
        const editor = new FakeElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        editor.dataset.annotationId = '42R0';
        editor.style.fill = 'rgb(0, 0, 0)';
        const renderedHighlight = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        renderedHighlight.setAttribute('fill', '#bad3fc');
        editor.append(renderedHighlight);
        connectToPage(page, editor);
        container.annotations = [editor];
        page.annotations = [editor];
        container.ownerDocument.elementsAtPoint = [editor];

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#3b82f6',
                subtype: 'Highlight',
            }),
            300,
            225,
        );

        expect(diagnostics.color).toBe('#bad3fc');
        expect(diagnostics.source).toBe('point:visual-node');
    });

    it('keeps an existing raw highlight swatch color instead of replacing it with display paint', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);
        const editor = new FakeElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        editor.dataset.annotationId = '42R0';
        editor.style.fill = 'rgb(0, 0, 0)';
        const renderedHighlight = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        renderedHighlight.setAttribute('fill', '#bad3fc');
        editor.append(renderedHighlight);
        connectToPage(page, editor);
        container.annotations = [editor];
        page.annotations = [editor];
        container.ownerDocument.elementsAtPoint = [editor];

        const resolved = resolveCommentWithRenderedTextMarkupColorAtPoint(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#3b82f6',
                subtype: 'Highlight',
            }),
            300,
            225,
        );

        expect(resolved?.color).toBe('#3b82f6');
    });

    it('uses the visible canvas color for context-menu swatches instead of a stale non-painted underline variable', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);
        const staleAnnotation = new FakeElement('underlineAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleAnnotation.dataset.annotationId = '42R0';
        staleAnnotation.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        connectToPage(page, staleAnnotation);
        container.annotations = [staleAnnotation];
        page.annotations = [staleAnnotation];

        const canvas = new FakeElement('canvas', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        }) as FakeElement & {
            getContext: ReturnType<typeof vi.fn>;
            height: number;
            width: number;
        };
        canvas.tagName = 'canvas';
        canvas.width = 1000;
        canvas.height = 1000;
        canvas.getContext = vi.fn((_contextType: string, _options: unknown) => {
            const getImageData = (_left: number, _top: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const centerIndex = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
                data[centerIndex] = 239;
                data[centerIndex + 1] = 68;
                data[centerIndex + 2] = 68;
                data[centerIndex + 3] = 255;
                return { data };
            };
            return { getImageData };
        });
        connectToPage(page, canvas);
        container.ownerDocument.elementsAtPoint = [
            staleAnnotation,
            canvas,
        ];

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                subtype: 'Underline',
            }),
            300,
            225,
        );

        expect(diagnostics.color).toBe('#ef4444');
        expect(diagnostics.source).toBe('canvas');
    });

    it('prefers the visible underline line at the click point over stale editor dataset color', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);
        const staleEditor = new FakeElement('highlightEditor pdf-markup-subtype-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleEditor.dataset.annotationId = '42R0';
        staleEditor.dataset.markupSubtypeColor = '#22c55e';
        staleEditor.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        connectToPage(page, staleEditor);
        container.annotations = [staleEditor];
        page.annotations = [staleEditor];

        const visibleUnderline = new FakeElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        visibleUnderline.tagName = 'svg';
        visibleUnderline.style.setProperty('--pdf-markup-subtype-color', '#ef4444');
        visibleUnderline.setAttribute('fill', 'none');
        visibleUnderline.setAttribute('stroke', '#ef4444');
        page.svgs = [visibleUnderline];
        container.ownerDocument.elementsAtPoint = [staleEditor];

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#22c55e',
                subtype: 'Underline',
            }),
            200,
            225,
        );

        expect(diagnostics.color).toBe('#ef4444');
        expect(diagnostics.source).toBe('point:nearby-element');
    });

    it('ignores hidden stale strikeout editor paint and resolves the visible rendered line color', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);
        const hiddenEditor = new FakeElement('strikeoutAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        hiddenEditor.dataset.annotationId = '99R0';
        hiddenEditor.setAttribute('stroke', '#111827');
        hiddenEditor.style.opacity = '0';
        connectToPage(page, hiddenEditor);
        container.annotations = [hiddenEditor];
        page.annotations = [hiddenEditor];

        const visibleStrikeout = new FakeElement('highlight', {
            left: 100,
            top: 225,
            width: 200,
            height: 3,
        });
        visibleStrikeout.setAttribute('stroke', '#ef4444');
        page.svgs = [visibleStrikeout];

        const color = resolveAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: '99R0',
                subtype: 'StrikeOut',
            }),
        );

        expect(color).toBe('#ef4444');
    });

    it('uses underline stroke instead of a stale generic highlight fill', () => {
        installFakeComputedStyle();
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
        connectPage(container, page);

        const matchingVisual = new FakeElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const staleFillPath = new FakeElement('path', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleFillPath.setAttribute('fill', '#22c55e');
        const visibleLine = new FakeElement('line', {
            left: 100,
            top: 225,
            width: 200,
            height: 3,
        });
        visibleLine.setAttribute('stroke', '#ef4444');
        matchingVisual.append(staleFillPath);
        matchingVisual.append(visibleLine);
        page.svgs = [matchingVisual];

        const color = resolveAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
            }),
        );

        expect(color).toBe('#ef4444');
    });
});
