import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import {
    PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS,
    PDF_LAYER_VISUAL_SNAPSHOT_CLASS,
    PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS,
} from '@app/composables/pdf/pdfLayerVisualSnapshot';

const TRACE_SECTION = 'pdf-annotation-save-trace';
const TRACE_FILE_PATH = '/tmp/evb-pdf-annotation-save-trace.jsonl';
const MAX_TRACE_ENTRIES = 2000;
const ANNOTATION_VISUAL_SELECTOR = [
    '.editorAnnotation',
    '.highlightAnnotation',
    '.underlineAnnotation',
    '.strikeoutAnnotation',
    '.squigglyAnnotation',
    '[data-annotation-id]',
].join(', ');

interface IAnnotationSaveTraceEntry {
    event: string;
    payload?: Record<string, unknown>;
    sequence: number;
    timestamp: string;
}

interface IWindowWithAnnotationSaveTrace extends Window {
    __evbPdfAnnotationSaveTrace?: IAnnotationSaveTraceEntry[];
    __evbFlushPdfAnnotationSaveTrace?: () => Promise<string>;
}

let sequence = 0;
let flushTimer: number | null = null;
let isFlushPending = false;

function getTraceWindow() {
    return typeof window === 'undefined'
        ? null
        : window as IWindowWithAnnotationSaveTrace;
}

function getTraceEntries() {
    const traceWindow = getTraceWindow();
    if (!traceWindow) {
        return [];
    }

    traceWindow.__evbPdfAnnotationSaveTrace ??= [];
    return traceWindow.__evbPdfAnnotationSaveTrace;
}

function isTraceEnabled() {
    return import.meta.dev && Boolean(getTraceWindow());
}

function trimTraceEntries(entries: IAnnotationSaveTraceEntry[]) {
    if (entries.length <= MAX_TRACE_ENTRIES) {
        return;
    }
    entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function count(root: ParentNode | null | undefined, selector: string) {
    if (!root) {
        return 0;
    }
    try {
        return root.querySelectorAll(selector).length;
    } catch {
        return 0;
    }
}

function round(value: number) {
    return Math.round(value * 100) / 100;
}

function elementState(element: Element | null | undefined) {
    if (!element || !(element instanceof HTMLElement || element instanceof SVGElement)) {
        return null;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
        classes: element.getAttribute('class') ?? '',
        childElementCount: element.childElementCount,
        display: style.display,
        height: round(rect.height),
        hidden: element instanceof HTMLElement ? element.hidden : false,
        innerHtmlLength: element.innerHTML.length,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        visibility: style.visibility,
        width: round(rect.width),
        zIndex: style.zIndex,
    };
}

function getEffectiveOpacity(element: Element, boundary: Element | null | undefined) {
    let current: Element | null = element;
    let opacity = 1;

    while (current) {
        const parsedOpacity = Number(window.getComputedStyle(current).opacity || '1');
        if (Number.isFinite(parsedOpacity)) {
            opacity *= parsedOpacity;
        }
        if (current === boundary) {
            break;
        }
        current = current.parentElement;
    }

    return Math.round(opacity * 1000) / 1000;
}

function visualElementState(element: Element, boundary: Element | null | undefined) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return null;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const effectiveOpacity = getEffectiveOpacity(element, boundary);
    return {
        classes: element.getAttribute('class') ?? '',
        dataAnnotationId: element.getAttribute('data-annotation-id'),
        display: style.display,
        effectiveOpacity,
        height: round(rect.height),
        opacity: style.opacity,
        visible: (
            style.display !== 'none'
            && style.visibility !== 'hidden'
            && effectiveOpacity > 0
            && rect.width > 0
            && rect.height > 0
        ),
        visibility: style.visibility,
        width: round(rect.width),
    };
}

function readSvgBBox(svg: SVGElement) {
    try {
        const getBBox = (svg as SVGGraphicsElement).getBBox;
        if (typeof getBBox !== 'function') {
            return null;
        }
        const bbox = getBBox.call(svg);
        return {
            height: round(bbox.height),
            width: round(bbox.width),
            x: round(bbox.x),
            y: round(bbox.y),
        };
    } catch {
        return null;
    }
}

function collectSvgPathStates(svg: SVGElement) {
    return Array.from(svg.querySelectorAll<SVGPathElement>('path'))
        .map(path => ({
            d: path.getAttribute('d')?.slice(0, 500) ?? null,
            fill: path.getAttribute('fill'),
            id: path.getAttribute('id'),
            stroke: path.getAttribute('stroke'),
        }))
        .slice(0, 8);
}

function collectSvgUseStates(svg: SVGElement) {
    return Array.from(svg.querySelectorAll<SVGUseElement>('use'))
        .map(use => ({
            class: use.getAttribute('class'),
            href: use.getAttribute('href') ?? use.getAttribute('xlink:href'),
            mask: use.getAttribute('mask'),
        }))
        .slice(0, 8);
}

function collectOverlayRectStates(svg: SVGElement) {
    if (!svg.classList.contains('pdf-highlight-composite-overlay')) {
        return [];
    }

    return Array.from(svg.querySelectorAll<SVGRectElement>('rect'))
        .map(rect => ({
            fill: rect.getAttribute('fill'),
            height: rect.getAttribute('height'),
            opacity: rect.getAttribute('fill-opacity'),
            width: rect.getAttribute('width'),
            x: rect.getAttribute('x'),
            y: rect.getAttribute('y'),
        }))
        .slice(0, 20);
}

function svgVisualState(svg: SVGElement, boundary: Element | null | undefined) {
    const visual = visualElementState(svg, boundary) ?? {};
    const style = window.getComputedStyle(svg);
    return {
        ...visual,
        bbox: readSvgBBox(svg),
        fill: svg.getAttribute('fill') ?? style.fill,
        fillOpacity: svg.getAttribute('fill-opacity') ?? style.fillOpacity,
        inlineStyle: svg.getAttribute('style'),
        overlayRects: collectOverlayRectStates(svg),
        pathCount: svg.querySelectorAll('path').length,
        paths: collectSvgPathStates(svg),
        snapshot: svg.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_CLASS),
        uses: collectSvgUseStates(svg),
        viewBox: svg.getAttribute('viewBox'),
    };
}

function selectionSummary() {
    try {
        const selection = window.getSelection();
        if (!selection) {
            return null;
        }
        return {
            collapsed: selection.isCollapsed,
            rangeCount: selection.rangeCount,
            text: selection.toString().slice(0, 500),
        };
    } catch {
        return null;
    }
}

function collectVisualElements(layer: Element | null | undefined) {
    if (!layer) {
        return [];
    }

    return Array.from(layer.querySelectorAll(ANNOTATION_VISUAL_SELECTOR))
        .flatMap((element) => {
            const state = visualElementState(element, layer);
            return state ? [state] : [];
        })
        .slice(0, 20);
}

function summarizeSnapshotLayer(snapshotLayer: Element) {
    const visuals = collectVisualElements(snapshotLayer);
    return {
        ...elementState(snapshotLayer),
        paintedAnnotations: visuals.filter(visual => visual.visible).length,
        visualAnnotations: visuals,
    };
}

function layerSummary(container: HTMLElement | null | undefined) {
    if (!container || typeof window === 'undefined') {
        return null;
    }

    const annotationLayer = container.querySelector<HTMLElement>('.annotation-layer, .annotationLayer');
    const editorLayer = container.querySelector<HTMLElement>('.annotation-editor-layer, .annotationEditorLayer');
    const canvasHost = container.querySelector<HTMLElement>('.page_canvas, .canvasWrapper');
    const annotationVisuals = collectVisualElements(annotationLayer);
    const snapshotLayers = [...container.querySelectorAll(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)]
        .map(summarizeSnapshotLayer);
    const drawSvgs = canvasHost
        ? [...canvasHost.querySelectorAll<SVGElement>('svg.highlight, svg.highlightOutline, svg.draw, svg.pdf-highlight-composite-overlay')]
        : [];
    const drawSvgStates = drawSvgs
        .map(svg => svgVisualState(svg, canvasHost))
        .slice(0, 12);

    return {
        annotationLayer: {
            ...elementState(annotationLayer),
            annotationElements: count(annotationLayer, '[data-annotation-id]'),
            highlightAnnotations: count(annotationLayer, '[class*="highlight"], [data-annotation-type*="Highlight"]'),
            paintedAnnotations: annotationVisuals.filter(visual => visual.visible).length,
            underlineAnnotations: count(annotationLayer, '[class*="underline"], [data-annotation-type*="Underline"]'),
            visualAnnotations: annotationVisuals,
        },
        canvasHost: {
            ...elementState(canvasHost),
            compositeOverlays: count(canvasHost, 'svg.pdf-highlight-composite-overlay'),
            drawSvgClasses: drawSvgs.map(svg => svg.getAttribute('class') ?? '').slice(0, 12),
            drawSvgStates,
            drawSvgs: drawSvgs.length,
            hasActiveSnapshotSuppression: canvasHost?.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS) ?? false,
            hiddenCompositeSources: count(canvasHost, '.pdf-highlight-composite-source'),
            hiddenSnapshotSources: count(canvasHost, `.${PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS}`),
            snapshotDrawSvgs: count(canvasHost, `svg.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`),
        },
        editorLayer: {
            ...elementState(editorLayer),
            highlightEditors: count(editorLayer, '.highlightEditor, [class*="highlight"]'),
            selectedEditors: count(editorLayer, '.selectedEditor, [class*="selected"]'),
            underlineEditors: count(editorLayer, '[class*="underline"]'),
        },
        page: {
            ...elementState(container),
            dataPageNumber: container.dataset.pageNumber ?? container.dataset.page ?? null,
            rendered: container.classList.contains('page_container--rendered'),
            selection: selectionSummary(),
            activeSnapshotSuppressionLayers: count(container, `.${PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS}`),
            hiddenSnapshotSources: count(container, `.${PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS}`),
            snapshots: count(container, `.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`),
            snapshotLayers,
        },
    };
}

export const PDF_ANNOTATION_SAVE_TRACE_FILE_PATH = TRACE_FILE_PATH;

export function tracePdfAnnotationSaveEvent(
    event: string,
    payload?: Record<string, unknown>,
) {
    if (!isTraceEnabled()) {
        return;
    }

    const entries = getTraceEntries();
    const entry: IAnnotationSaveTraceEntry = {
        event,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
    };
    if (payload !== undefined) {
        entry.payload = payload;
    }

    entries.push(entry);
    trimTraceEntries(entries);
    BrowserLogger.warn(TRACE_SECTION, event, payload);
    scheduleTraceFlush();
}

export function tracePdfAnnotationSaveDom(
    event: string,
    container: HTMLElement | null | undefined,
    payload?: Record<string, unknown>,
) {
    tracePdfAnnotationSaveEvent(event, {
        ...payload,
        layers: layerSummary(container),
    });
}

export async function flushPdfAnnotationSaveTrace() {
    const entries = getTraceEntries();
    const data = entries.map(entry => JSON.stringify(entry)).join('\n');
    const traceData = `${data}\n`;
    if (typeof fetch === 'function') {
        const response = await fetch('/api/dev/pdfAnnotationSaveTrace', {
            body: JSON.stringify({ data: traceData }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
        }).catch(() => null);
        if (response?.ok) {
            return TRACE_FILE_PATH;
        }
    }

    const bytes = new TextEncoder().encode(traceData);
    await getDocumentsCapability().writeFile(TRACE_FILE_PATH, bytes);
    return TRACE_FILE_PATH;
}

function scheduleTraceFlush() {
    const traceWindow = getTraceWindow();
    if (!traceWindow) {
        return;
    }
    traceWindow.__evbFlushPdfAnnotationSaveTrace = flushPdfAnnotationSaveTrace;

    if (flushTimer !== null || isFlushPending) {
        return;
    }

    flushTimer = window.setTimeout(() => {
        flushTimer = null;
        isFlushPending = true;
        flushPdfAnnotationSaveTrace()
            .catch((error: unknown) => {
                BrowserLogger.debug(
                    TRACE_SECTION,
                    `Failed to write trace file at ${TRACE_FILE_PATH}`,
                    error,
                );
            })
            .finally(() => {
                isFlushPending = false;
            });
    }, 250);
}
