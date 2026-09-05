import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import {
    activatePdfLayerVisualSnapshotHost,
    createPdfLayerVisualSnapshotRelease,
    disablePdfLayerVisualSnapshotInteractivity,
    hidePdfLayerVisualSnapshotSource,
} from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';

interface IPdfLayerVisualSnapshotOptions {
    excludeSelectors?: string[] | undefined;
    suppressLiveContentWhenEmpty?: boolean | undefined;
}

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    if (!root) {
        return [];
    }
    return Array.from(root.querySelectorAll<T>(selector));
}

function getChildren(element: Element | null | undefined) {
    return element?.children
        ? Array.from(element.children)
        : [];
}

function removeExcludedSnapshotContent(
    snapshot: HTMLElement,
    options: IPdfLayerVisualSnapshotOptions,
) {
    const selectors = options.excludeSelectors?.filter(Boolean) ?? [];
    selectors.forEach((selector) => {
        queryAll(snapshot, selector).forEach(element => element.remove());
    });
}

function isSnapshotElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotClass}`));
}

function hideLiveLayerSnapshotSources(layer: HTMLElement) {
    return getChildren(layer)
        .filter(child => !isSnapshotElement(child))
        .map(child => hidePdfLayerVisualSnapshotSource(child as HTMLElement | SVGElement));
}

export function preservePdfLayerVisualSnapshot(
    layer: HTMLElement | null | undefined,
    options: IPdfLayerVisualSnapshotOptions = {},
) {
    const parent = layer?.parentElement;
    if (!layer || !parent || layer.hidden) {
        return null;
    }
    if (layer.childElementCount === 0 && !options.suppressLiveContentWhenEmpty) {
        return null;
    }

    const snapshot = layer.cloneNode(true) as HTMLElement;
    removeExcludedSnapshotContent(snapshot, options);
    const hasSnapshotContent = snapshot.childElementCount > 0;
    if (!hasSnapshotContent && !options.suppressLiveContentWhenEmpty) {
        return null;
    }
    snapshot.classList.add(pdfLayerVisualSnapshotClass);
    disablePdfLayerVisualSnapshotInteractivity(snapshot);
    const restoreOriginals = [
        activatePdfLayerVisualSnapshotHost(layer),
        ...hideLiveLayerSnapshotSources(layer),
    ];
    try {
        if (hasSnapshotContent) {
            parent.append(snapshot);
        }
    } catch (error) {
        restoreOriginals.forEach(restore => restore());
        throw error;
    }
    return createPdfLayerVisualSnapshotRelease(hasSnapshotContent ? [snapshot] : [], restoreOriginals);
}
