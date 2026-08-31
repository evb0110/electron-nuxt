import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import {
    activatePdfLayerVisualSnapshotHost,
    createPdfLayerVisualSnapshotRelease,
    disablePdfLayerVisualSnapshotInteractivity,
    hidePdfLayerVisualSnapshotSource,
    isPdfLayerVisualElementVisiblyPainted,
    isPdfLayerVisualSnapshotElement,
    queryPdfLayerVisualSnapshotElements,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

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

function getElementAndDescendants(element: Element) {
    return [
        element,
        ...queryPdfLayerVisualSnapshotElements(element, '*'),
    ];
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
        disablePdfLayerVisualSnapshotInteractivity(snapshot);
        return {
            drawNode,
            snapshot,
        };
    });

    const restoreOriginals = [
        activatePdfLayerVisualSnapshotHost(canvasHost),
        ...snapshotPairs.map(({ drawNode }) => hidePdfLayerVisualSnapshotSource(drawNode)),
    ];
    const snapshots = snapshotPairs.map(({ snapshot }) => snapshot);
    try {
        snapshots.forEach(snapshot => canvasHost.append(snapshot));
    } catch (error) {
        snapshots.forEach(snapshot => snapshot.remove());
        restoreOriginals.forEach(restore => restore());
        throw error;
    }

    return createPdfLayerVisualSnapshotRelease(snapshots, restoreOriginals);
}
