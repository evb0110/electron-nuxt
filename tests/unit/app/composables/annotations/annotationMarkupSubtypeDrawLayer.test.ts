import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createAnnotationMarkupSubtypeDrawLayer } from '@app/utils/pdf-viewer/annotations/annotation-markup-subtype-draw-layer/createAnnotationMarkupSubtypeDrawLayer';

interface IFakeRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

class FakeStyle {
    height = '';
    left = '';
    top = '';
    width = '';
    private readonly properties = new Map<string, string>();

    setProperty(name: string, value: string) {
        this.properties.set(name, value);
    }

    getPropertyValue(name: string) {
        return this.properties.get(name) ?? '';
    }

    removeProperty(name: string) {
        this.properties.delete(name);
    }
}

class FakeClassList {
    private readonly classes: Set<string>;

    constructor(className: string) {
        this.classes = new Set(className.split(/\s+/).filter(Boolean));
    }

    add(...classNames: string[]) {
        classNames.forEach(className => this.classes.add(className));
    }

    remove(...classNames: string[]) {
        classNames.forEach(className => this.classes.delete(className));
    }

    contains(className: string) {
        return this.classes.has(className);
    }

    toString() {
        return [...this.classes].join(' ');
    }
}

class FakeElement {
    readonly children: FakeElement[] = [];
    readonly style = new FakeStyle();
    classList: FakeClassList;
    isConnected = true;
    parentElement: FakeElement | null = null;
    private readonly attributes = new Map<string, string>();

    constructor(
        public className: string,
        private readonly rect: IFakeRect,
        readonly tagName = 'svg',
    ) {
        this.classList = new FakeClassList(className);
    }

    append(child: FakeElement) {
        child.parentElement = this;
        this.children.push(child);
    }

    contains(element: FakeElement): boolean {
        return element === this || this.children.some(child => child.contains(element));
    }

    closest(selector: string) {
        if (selector === '.page_container') {
            if (this.classList.contains('page_container')) {
                return this;
            }
            let current = this.parentElement;
            while (current) {
                if (current.classList.contains('page_container')) {
                    return current;
                }
                current = current.parentElement;
            }
        }
        return null;
    }

    getAttribute(name: string) {
        if (name === 'class') {
            return this.className;
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
            x: this.rect.left,
            y: this.rect.top,
            toJSON: () => this.rect,
        } as DOMRect;
    }

    querySelector() {
        return null;
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

    matches(selector: string) {
        if (selector.split(',').map(part => part.trim()).includes(this.tagName.toLowerCase())) {
            return true;
        }
        if (selector === 'svg.highlight') {
            return this.tagName.toLowerCase() === 'svg' && this.classList.contains('highlight');
        }
        if (selector.includes('pdf-markup-subtype-draw-visual')) {
            return this.className.includes('pdf-markup-subtype-draw-visual');
        }
        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }
        return false;
    }

    remove() {
        this.isConnected = false;
        const siblingIndex = this.parentElement?.children.indexOf(this) ?? -1;
        if (siblingIndex >= 0) {
            this.parentElement?.children.splice(siblingIndex, 1);
        }
    }
}

describe('createAnnotationMarkupSubtypeDrawLayer', () => {
    it('removes stale standalone underline visuals before drawing the recolored visual', () => {
        const page = new FakeElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        }, 'div');
        const pageCanvas = new FakeElement('page_canvas', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        }, 'div');
        page.append(pageCanvas);

        const rect = {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        };
        const highlightSvg = new FakeElement('highlight pdf-markup-subtype-draw-underline', rect);
        highlightSvg.style.left = '10%';
        highlightSvg.style.top = '20%';
        highlightSvg.style.width = '40%';
        highlightSvg.style.height = '8%';
        highlightSvg.setAttribute('fill', '#ef4444');
        const staleBasePath = new FakeElement('path', rect, 'path');
        staleBasePath.setAttribute('stroke', '#ef4444');
        highlightSvg.append(staleBasePath);
        pageCanvas.append(highlightSvg);

        const staleUnderlineSvg = new FakeElement(
            'draw pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-visual--underline pdf-markup-subtype-draw-underline',
            rect,
        );
        pageCanvas.append(staleUnderlineSvg);

        const editorDiv = new FakeElement('', rect, 'div');
        page.append(editorDiv);

        const draw = vi.fn((_options: unknown) => ({ id: 7 }));
        const drawLayer = {
            draw,
            remove: vi.fn(),
        };
        const manager = createAnnotationMarkupSubtypeDrawLayer();

        const didApply = manager.applyMarkupSubtypeDrawLayerClass(
            {
                div: editorDiv,
                parent: { drawLayer },
                pageDimensions: [
                    1000,
                    1000,
                ],
                __evbMarkupBoxes: [{
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.08,
                }],
            } as never,
            'Underline',
            '#22c55e',
        );

        expect(didApply).toBe(true);
        expect(staleUnderlineSvg.isConnected).toBe(false);
        expect(highlightSvg.getAttribute('fill')).toBe('transparent');
        expect(staleBasePath.getAttribute('stroke')).toBe('transparent');
        expect(draw).toHaveBeenCalledTimes(1);
        expect(draw.mock.calls[0]?.[0]).toMatchObject({
            path: { stroke: '#22c55e' },
            root: {
                fill: 'transparent',
                'fill-opacity': '0',
            },
        });
    });
});
