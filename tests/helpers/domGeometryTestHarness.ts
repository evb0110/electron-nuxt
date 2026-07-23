import { vi } from 'vitest';
import { cast } from '@tests/helpers/cast';

export interface ITestRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ITestClassList {
    add: (...args: string[]) => void;
    contains: (className: string) => boolean;
    remove: (...args: string[]) => void;
}

export interface ITestNode {
    style: Record<string, string>;
    classList: ITestClassList;
    isConnected?: boolean;
    dataset?: Record<string, string>;
    getAttribute?: (name: string) => string | null;
    offsetTop?: number;
    offsetWidth?: number;
    offsetHeight?: number;
    clientWidth?: number;
    clientHeight?: number;
    innerHTML?: string;
    hidden?: boolean;
    dir?: string;
    appendChild?: (...args: unknown[]) => void;
    replaceChildren?: (...args: unknown[]) => void;
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => unknown[];
}

export interface ITestCanvasNode extends ITestNode {
    width: number;
    height: number;
    remove: () => void;
}

export function createTestDomRect(rect: ITestRect): DOMRect {
    const {
        left,
        top,
        width,
        height,
    } = rect;
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => ({
            bottom: top + height,
            height,
            left,
            right: left + width,
            top,
            width,
            x: left,
            y: top,
        }),
        top,
        width,
        x: left,
        y: top,
    };
}

export function setTestElementRect<T extends Element>(element: T, rect: ITestRect) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => createTestDomRect(rect),
    });
    return element;
}

export function createTestClassList(): ITestClassList {
    const classNames = new Set<string>();
    return {
        add: vi.fn((...args: string[]) => {
            args.forEach(className => classNames.add(className));
        }),
        contains: vi.fn((className: string) => classNames.has(className)),
        remove: vi.fn((...args: string[]) => {
            args.forEach(className => classNames.delete(className));
        }),
    };
}

export function createTestCanvasNode(): ITestCanvasNode {
    return {
        width: 120,
        height: 180,
        isConnected: true,
        remove: vi.fn(),
        style: {},
        classList: createTestClassList(),
    };
}

export function createTestPageContainer(overrides?: {
    pageNumber?: number;
    textLayerDiv?: ITestNode | null;
    annotationLayerDiv?: ITestNode | null;
    annotationEditorLayerDiv?: ITestNode | null;
    hasShapeOverlay?: boolean;
    shapeOverlayAnnotationIds?: string[];
    offsetWidth?: number;
    offsetHeight?: number;
}) {
    const pageNumber = overrides?.pageNumber ?? 1;
    let mountedCanvas: unknown = null;
    const overlayAnnotationIds = overrides?.shapeOverlayAnnotationIds
        ?? (overrides?.hasShapeOverlay === true ? ['12R'] : []);
    const overlayElements: ITestNode[] = overlayAnnotationIds.map(annotationId => ({
        dataset: {annotationId},
        style: {},
        classList: createTestClassList(),
        getAttribute: name => name === 'data-annotation-id' ? annotationId : null,
    }));
    const canvasHost: ITestNode = {
        innerHTML: '',
        style: {},
        classList: createTestClassList(),
        appendChild: vi.fn((canvas: unknown) => {
            mountedCanvas = canvas;
        }),
        replaceChildren: vi.fn(() => {
            mountedCanvas = null;
        }),
    };
    const skeleton: ITestNode = {
        style: {display: ''},
        classList: createTestClassList(),
    };
    const textLayerDiv = overrides?.textLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createTestClassList(),
    };
    const annotationLayerDiv = overrides?.annotationLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createTestClassList(),
        replaceChildren: vi.fn(),
    };
    const annotationEditorLayerDiv = overrides?.annotationEditorLayerDiv ?? {
        innerHTML: '',
        hidden: false,
        dir: 'ltr',
        style: {},
        classList: createTestClassList(),
        replaceChildren: vi.fn(),
    };
    annotationLayerDiv.replaceChildren ??= vi.fn();
    annotationEditorLayerDiv.replaceChildren ??= vi.fn();

    const pageContainer: ITestNode = {
        dataset: {page: String(pageNumber)},
        offsetTop: 0,
        offsetWidth: overrides?.offsetWidth ?? 120,
        offsetHeight: overrides?.offsetHeight ?? 180,
        clientWidth: overrides?.offsetWidth ?? 120,
        clientHeight: overrides?.offsetHeight ?? 180,
        style: {},
        classList: createTestClassList(),
        querySelector: vi.fn((selector: string) => {
            if (selector === '.page_canvas canvas') {
                return mountedCanvas;
            }
            return {
                '.page_canvas': canvasHost,
                '.page_canvas__render-layer': canvasHost,
                '.document-page-skeleton': skeleton,
                '.text-layer': textLayerDiv,
                '.annotation-layer': annotationLayerDiv,
                '.annotation-editor-layer': annotationEditorLayerDiv,
                '.pdf-shape-overlay.has-shapes': overlayElements.length > 0 ? {} : null,
            }[selector] ?? null;
        }),
        querySelectorAll: vi.fn((selector: string) => (
            selector === '.pdf-shape-overlay.has-shapes [data-annotation-id]'
                ? overlayElements
                : []
        )),
    };

    return {
        pageContainer,
        canvasHost,
        textLayerDiv,
        setMountedCanvas: (canvas: unknown) => {
            mountedCanvas = canvas;
        },
    };
}

export function createTestPageContainerRoot(
    pageContainerOrContainers: ITestNode | ITestNode[],
) {
    const pageContainers = Array.isArray(pageContainerOrContainers)
        ? pageContainerOrContainers
        : [pageContainerOrContainers];
    return cast<HTMLElement>({
        querySelectorAll: vi.fn((selector: string) => (
            selector === '.page_container' ? pageContainers : []
        )),
        querySelector: vi.fn((selector: string) => {
            const pageMatch = selector.match(/^\.page_container\[data-page="(\d+)"\]$/);
            return pageMatch
                ? pageContainers.find(page => page.dataset?.page === pageMatch[1]) ?? null
                : null;
        }),
    });
}

export function createTestPageRenderResult() {
    return {
        canvas: cast<HTMLCanvasElement>(createTestCanvasNode()),
        viewport: {
            width: 120,
            height: 180,
            rawDims: {
                pageWidth: 120,
                pageHeight: 180,
            },
        },
        scaleX: 1,
        scaleY: 1,
        rawDims: {
            pageWidth: 120,
            pageHeight: 180,
        },
        userUnit: 1,
        totalScaleFactor: 1,
    };
}

export function createTestPageLease<TPage extends object>(page: TPage) {
    let released = false;
    const release = vi.fn(() => {
        if (!released) {
            released = true;
            (page as {cleanup?: () => void}).cleanup?.();
        }
    });
    return {
        page,
        release,
    };
}
