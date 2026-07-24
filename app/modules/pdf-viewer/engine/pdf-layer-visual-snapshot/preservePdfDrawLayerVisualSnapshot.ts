import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';
import {
    isPdfLayerVisualElementVisiblyPainted,
    isPdfLayerVisualSnapshotElement,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';
import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

const DRAW_LAYER_VISUAL_SELECTOR = [
    ':scope > svg.highlight',
    ':scope > svg.highlightOutline',
    ':scope > svg.draw',
    ':scope > svg.pdf-highlight-composite-overlay',
].join(', ');

const COMPOSITE_SOURCE_CLASS = 'pdf-highlight-composite-source';

const SVG_REFERENCE_ATTRIBUTES = [
    'clip-path',
    'filter',
    'fill',
    'href',
    'mask',
    'stroke',
    'style',
    'xlink:href',
];

let snapshotSvgIdSequence = 0;

const activeSnapshotHostCounts = new WeakMap<Element, number>();

function disableSnapshotInteractivity(snapshot: Element) {
    snapshot.setAttribute('aria-hidden', 'true');
    if (snapshot instanceof HTMLElement) {
        snapshot.inert = true;
    }

    queryPdfLayerVisualSnapshotElements<HTMLElement>(snapshot, 'a, button, input, select, textarea, [tabindex]')
        .forEach((element) => {
            element.tabIndex = -1;
        });
}

function createRelease(
    snapshots: Element[],
    restoreOriginals: Array<() => void> = [],
): TPdfLayerVisualSnapshotRelease | null {
    if (snapshots.length === 0 && restoreOriginals.length === 0) {
        return null;
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        snapshots.forEach(snapshot => snapshot.remove());
        restoreOriginals.forEach(restoreOriginal => restoreOriginal());
    };
}

function getElementAndDescendants(element: Element) {
    return [
        element,
        ...queryPdfLayerVisualSnapshotElements(element, '*'),
    ];
}

function activateVisualSnapshotHost(host: HTMLElement) {
    const nextCount = (activeSnapshotHostCounts.get(host) ?? 0) + 1;
    activeSnapshotHostCounts.set(host, nextCount);
    host.classList.add(pdfLayerVisualSnapshotActiveClass);

    return () => {
        const currentCount = activeSnapshotHostCounts.get(host) ?? 1;
        const remainingCount = Math.max(0, currentCount - 1);
        if (remainingCount > 0) {
            activeSnapshotHostCounts.set(host, remainingCount);
            return;
        }
        activeSnapshotHostCounts.delete(host);
        host.classList.remove(pdfLayerVisualSnapshotActiveClass);
    };
}

function rewriteSvgReferenceValue(value: string, idMap: Map<string, string>) {
    if (value.startsWith('#')) {
        const targetId = value.slice(1);
        const nextId = idMap.get(targetId);
        return nextId ? `#${nextId}` : value;
    }

    return value.replace(/url\((['"]?)#([^)'" ]+)\1\)/g, (match, quote: string, id: string) => {
        const nextId = idMap.get(id);
        return nextId ? `url(${quote}#${nextId}${quote})` : match;
    });
}

function uniquifyClonedSvgReferences(snapshot: SVGElement) {
    const elements = getElementAndDescendants(snapshot);
    const idMap = new Map<string, string>();
    const prefix = `pdf_layer_snapshot_${snapshotSvgIdSequence += 1}_`;

    elements.forEach((element) => {
        const id = element.getAttribute('id');
        if (!id) {
            return;
        }
        const nextId = `${prefix}${id}`;
        idMap.set(id, nextId);
        element.setAttribute('id', nextId);
    });

    if (idMap.size === 0) {
        return;
    }

    elements.forEach((element) => {
        SVG_REFERENCE_ATTRIBUTES.forEach((attribute) => {
            const value = element.getAttribute(attribute);
            if (!value) {
                return;
            }
            const nextValue = rewriteSvgReferenceValue(value, idMap);
            if (nextValue !== value) {
                element.setAttribute(attribute, nextValue);
            }
        });
    });
}

function hideLiveElementDuringSnapshot(element: HTMLElement | SVGElement) {
    const hadHiddenSourceClass = element.classList.contains(pdfLayerVisualSnapshotSourceClass);
    const previousVisibility = element.style.visibility;
    element.classList.add(pdfLayerVisualSnapshotSourceClass);
    element.style.visibility = 'hidden';
    return () => {
        if ('isConnected' in element && !element.isConnected) {
            return;
        }
        if (!hadHiddenSourceClass) {
            element.classList.remove(pdfLayerVisualSnapshotSourceClass);
        }
        element.style.visibility = previousVisibility;
    };
}

export function preservePdfDrawLayerVisualSnapshot(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return null;
    }

    const drawNodes = queryPdfLayerVisualSnapshotElements<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).filter(drawNode => (
        !isPdfLayerVisualSnapshotElement(drawNode)
        && !drawNode.classList.contains(COMPOSITE_SOURCE_CLASS)
        && isPdfLayerVisualElementVisiblyPainted(drawNode)
    ));
    if (drawNodes.length === 0) {
        return null;
    }

    const snapshotPairs = drawNodes.map((drawNode) => {
        const snapshot = drawNode.cloneNode(true) as SVGElement;
        snapshot.classList.add(pdfLayerVisualSnapshotClass);
        uniquifyClonedSvgReferences(snapshot);
        disableSnapshotInteractivity(snapshot);
        return {
            drawNode,
            snapshot,
        };
    });

    const restoreOriginals = [
        activateVisualSnapshotHost(canvasHost),
        ...snapshotPairs.map(({ drawNode }) => hideLiveElementDuringSnapshot(drawNode)),
    ];
    const snapshots = snapshotPairs.map(({ snapshot }) => snapshot);
    try {
        snapshots.forEach(snapshot => canvasHost.append(snapshot));
    } catch (error) {
        snapshots.forEach(snapshot => snapshot.remove());
        restoreOriginals.forEach(restore => restore());
        throw error;
    }

    return createRelease(snapshots, restoreOriginals);
}
