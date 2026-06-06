import { pdfLayerVisualSnapshotActiveClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';
import type { TPdfLayerVisualSnapshotRelease } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

interface IPdfLayerVisualSnapshotOptions {
    excludeSelectors?: string[] | undefined;
    suppressLiveContentWhenEmpty?: boolean | undefined;
}

const activeSnapshotHostCounts = new WeakMap<Element, number>();

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

function getChildren(element: Element | null | undefined) {
    return element?.children
        ? Array.from(element.children)
        : [];
}

function disableSnapshotInteractivity(snapshot: Element) {
    snapshot.setAttribute('aria-hidden', 'true');
    if (snapshot instanceof HTMLElement) {
        snapshot.inert = true;
    }

    queryAll<HTMLElement>(snapshot, 'a, button, input, select, textarea, [tabindex]')
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

function hideLiveLayerSnapshotSources(layer: HTMLElement) {
    return getChildren(layer)
        .filter(child => !isSnapshotElement(child))
        .map(child => hideLiveElementDuringSnapshot(child as HTMLElement | SVGElement));
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
    disableSnapshotInteractivity(snapshot);
    const restoreOriginals = [
        activateVisualSnapshotHost(layer),
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
    return createRelease(hasSnapshotContent ? [snapshot] : [], restoreOriginals);
}
