export type TPdfLayerVisualSnapshotRelease = () => void;

export const PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS = 'pdf-layer-preserve-active';
export const PDF_LAYER_VISUAL_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';
export const PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS = 'pdf-layer-preserve-hidden-source';

interface IPdfLayerVisualSnapshotReleaseOptions {
    maxDelayMs?: number;
    minFrames?: number;
    waitFor?: () => boolean;
}

interface IPdfLayerVisualSnapshotOptions {
    excludeSelectors?: string[] | undefined;
    suppressLiveContentWhenEmpty?: boolean | undefined;
}

const DRAW_LAYER_VISUAL_SELECTOR = [
    ':scope > svg.highlight',
    ':scope > svg.highlightOutline',
    ':scope > svg.draw',
    ':scope > svg.pdf-highlight-composite-overlay',
].join(', ');
const ANNOTATION_LAYER_VISUAL_SELECTOR = [
    '.editorAnnotation',
    '.highlightAnnotation',
    '.underlineAnnotation',
    '.strikeoutAnnotation',
    '.squigglyAnnotation',
    '[data-annotation-id]',
].join(', ');
const TEXT_MARKUP_EDITOR_SELECTOR = [
    '.highlightEditor',
    '[role="mark"]',
    '[class*="pdf-markup-subtype"]',
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

export function combinePdfLayerVisualSnapshotReleases(
    releases: Array<TPdfLayerVisualSnapshotRelease | null | undefined>,
) {
    const activeReleases = releases.filter(Boolean) as TPdfLayerVisualSnapshotRelease[];
    if (activeReleases.length === 0) {
        return null;
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        activeReleases.forEach(release => release());
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
    snapshot.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_CLASS);
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

export function preservePdfDrawLayerVisualSnapshot(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return null;
    }

    const drawNodes = queryAll<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).filter(drawNode => (
        !isSnapshotElement(drawNode)
        && !drawNode.classList.contains(COMPOSITE_SOURCE_CLASS)
        && isElementVisiblyPainted(drawNode)
    ));
    if (drawNodes.length === 0) {
        return null;
    }

    const snapshotPairs = drawNodes.map((drawNode) => {
        const snapshot = drawNode.cloneNode(true) as SVGElement;
        snapshot.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_CLASS);
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

function getCanvasHost(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper') ?? null
        : null;
}

function getAnnotationLayer(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-layer, .annotationLayer') ?? null
        : null;
}

function getAnnotationEditorLayer(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-editor-layer, .annotationEditorLayer') ?? null
        : null;
}

function isSnapshotElement(element: Element) {
    return element.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_CLASS)
        || Boolean(element.closest?.(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`));
}

function isSnapshotSourceElement(element: Element) {
    return element.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS)
        || Boolean(element.closest?.(`.${PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS}`));
}

function isInsideActiveSnapshotHost(element: Element) {
    return element.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS)
        || Boolean(element.closest?.(`.${PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS}`));
}

function getElementAndDescendants(element: Element) {
    return [
        element,
        ...queryAll(element, '*'),
    ];
}

function activateVisualSnapshotHost(host: HTMLElement) {
    const nextCount = (activeSnapshotHostCounts.get(host) ?? 0) + 1;
    activeSnapshotHostCounts.set(host, nextCount);
    host.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS);

    return () => {
        const currentCount = activeSnapshotHostCounts.get(host) ?? 1;
        const remainingCount = Math.max(0, currentCount - 1);
        if (remainingCount > 0) {
            activeSnapshotHostCounts.set(host, remainingCount);
            return;
        }
        activeSnapshotHostCounts.delete(host);
        host.classList.remove(PDF_LAYER_VISUAL_SNAPSHOT_ACTIVE_CLASS);
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

function hideLiveLayerSnapshotSources(layer: HTMLElement) {
    return getChildren(layer)
        .filter(child => !isSnapshotElement(child))
        .map(child => hideLiveElementDuringSnapshot(child as HTMLElement | SVGElement));
}

function hideLiveElementDuringSnapshot(element: HTMLElement | SVGElement) {
    const hadHiddenSourceClass = element.classList.contains(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);
    const previousVisibility = element.style.visibility;
    element.classList.add(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);
    element.style.visibility = 'hidden';
    return () => {
        if ('isConnected' in element && !element.isConnected) {
            return;
        }
        if (!hadHiddenSourceClass) {
            element.classList.remove(PDF_LAYER_VISUAL_SNAPSHOT_SOURCE_CLASS);
        }
        element.style.visibility = previousVisibility;
    };
}

function isElementVisiblyPainted(element: Element) {
    if (
        isSnapshotElement(element)
        || isSnapshotSourceElement(element)
        || isInsideActiveSnapshotHost(element)
    ) {
        return false;
    }
    return isElementPotentiallyPainted(element, { ignoreActiveSnapshotHostVisibility: false });
}

function isElementReadyForSnapshotRelease(element: Element) {
    if (isSnapshotElement(element) || isSnapshotSourceElement(element)) {
        return false;
    }
    return isElementPotentiallyPainted(element, { ignoreActiveSnapshotHostVisibility: true });
}

function isElementPotentiallyPainted(
    element: Element,
    options: { ignoreActiveSnapshotHostVisibility: boolean },
) {
    const isHtmlElement = typeof HTMLElement !== 'undefined' && element instanceof HTMLElement;
    const isSvgElement = typeof SVGElement !== 'undefined' && element instanceof SVGElement;
    if (!isHtmlElement && !isSvgElement) {
        return false;
    }
    if (isHtmlElement && element.hidden) {
        return false;
    }

    try {
        const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(element)
            : null;
        const activeSnapshotSuppressed = options.ignoreActiveSnapshotHostVisibility
            && isInsideActiveSnapshotHost(element);
        if (
            style
            && (
                style.display === 'none'
                || (style.visibility === 'hidden' && !activeSnapshotSuppressed)
                || Number(style.opacity || '1') <= 0
            )
        ) {
            return false;
        }

        const rect = typeof element.getBoundingClientRect === 'function'
            ? element.getBoundingClientRect()
            : null;
        return !rect || (rect.width > 0 && rect.height > 0);
    } catch {
        return true;
    }
}

function hasAnnotationLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryAll(layer, ANNOTATION_LAYER_VISUAL_SELECTOR)
        .some(isElementVisiblyPainted);
}

function hasAnnotationLayerReleaseContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryAll(layer, ANNOTATION_LAYER_VISUAL_SELECTOR)
        .some(isElementReadyForSnapshotRelease);
}

function hasAnnotationEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return getChildren(layer)
        .some(isElementVisiblyPainted);
}

function hasAnnotationEditorLayerReleaseContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return getChildren(layer)
        .some(isElementReadyForSnapshotRelease);
}

function hasTextMarkupEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryAll(layer, TEXT_MARKUP_EDITOR_SELECTOR)
        .some(isElementVisiblyPainted);
}

export function hasPdfDrawLayerVisualContent(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return false;
    }

    return queryAll<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).some(isElementVisiblyPainted);
}

function hasPdfDrawLayerReleaseContent(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return false;
    }

    return queryAll<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).some(isElementReadyForSnapshotRelease);
}

export function hasPdfPageDrawLayerVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return hasPdfDrawLayerVisualContent(getCanvasHost(pageContainer));
}

export function hasPdfPageAnnotationVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return (
        hasPdfPageDrawLayerVisualContent(pageContainer)
        || hasAnnotationLayerVisualContent(getAnnotationLayer(pageContainer))
        || hasAnnotationEditorLayerVisualContent(getAnnotationEditorLayer(pageContainer))
    );
}

export function hasPdfPageAnnotationVisualContentForSnapshotRelease(
    pageContainer: HTMLElement | null | undefined,
) {
    return (
        hasPdfDrawLayerReleaseContent(getCanvasHost(pageContainer))
        || hasAnnotationLayerReleaseContent(getAnnotationLayer(pageContainer))
        || hasAnnotationEditorLayerReleaseContent(getAnnotationEditorLayer(pageContainer))
    );
}

export function preservePdfPageAnnotationVisualSnapshot(
    pageContainer: HTMLElement | null | undefined,
    annotationEditorLayer: HTMLElement | null | undefined,
) {
    if (
        !pageContainer
        || typeof pageContainer.querySelector !== 'function'
        || pageContainer.querySelector(`.${PDF_LAYER_VISUAL_SNAPSHOT_CLASS}`)
    ) {
        return null;
    }

    const canvasHost = getCanvasHost(pageContainer);
    const editorLayer = annotationEditorLayer ?? getAnnotationEditorLayer(pageContainer);
    const hasDrawLayerVisuals = hasPdfDrawLayerVisualContent(canvasHost);
    const hasTextMarkupEditors = hasTextMarkupEditorLayerVisualContent(editorLayer);
    const annotationLayerExcludeSelectors = hasDrawLayerVisuals || hasTextMarkupEditors
        ? ['.editorAnnotation']
        : [];
    const editorLayerExcludeSelectors = hasTextMarkupEditors
        ? [TEXT_MARKUP_EDITOR_SELECTOR]
        : [];
    return combinePdfLayerVisualSnapshotReleases([
        preservePdfLayerVisualSnapshot(getAnnotationLayer(pageContainer), {
            excludeSelectors: annotationLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: annotationLayerExcludeSelectors.length > 0,
        }),
        preservePdfDrawLayerVisualSnapshot(canvasHost),
        preservePdfLayerVisualSnapshot(editorLayer, {
            excludeSelectors: editorLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: hasDrawLayerVisuals || editorLayerExcludeSelectors.length > 0,
        }),
    ]);
}

export function schedulePdfLayerVisualSnapshotRelease(
    release: TPdfLayerVisualSnapshotRelease | null | undefined,
    options: IPdfLayerVisualSnapshotReleaseOptions = {},
) {
    if (!release) {
        return;
    }

    const maxDelayMs = options.maxDelayMs ?? 0;
    const minFrames = options.minFrames ?? 1;
    const startTime = Date.now();
    let frameCount = 0;

    const shouldRelease = () => {
        frameCount += 1;
        if (frameCount < minFrames) {
            return false;
        }
        if (!options.waitFor || options.waitFor()) {
            return true;
        }
        return maxDelayMs > 0 && Date.now() - startTime >= maxDelayMs;
    };

    if (
        typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function'
    ) {
        const tick = () => {
            if (shouldRelease()) {
                release();
                return;
            }
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
        return;
    }

    setTimeout(release, 0);
}
