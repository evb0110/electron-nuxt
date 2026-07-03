import { BrowserLogger } from '@app/utils/browserLogger';

export type TPdfAnnotationEditorCompatPatch =
    | 'annotation-editor-layer-div-fallback'
    | 'annotation-editor-ui-current-layer-fallback'
    | 'annotation-editor-text-layer-div-ref';

export type TPdfAnnotationEditorCompatSeverity = 'ok' | 'patched' | 'unsupported';

export interface IPdfAnnotationEditorCompatibilityReport {
    pdfjsVersion: string;
    severity: TPdfAnnotationEditorCompatSeverity;
    appliedPatches: TPdfAnnotationEditorCompatPatch[];
    failures: string[];
}

export interface IPdfAnnotationEditorLayerLike {
    div?: HTMLElement | null;
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
}

export interface IPdfAnnotationEditorCompatibilityAdapter {
    report: IPdfAnnotationEditorCompatibilityReport;
    normalizeTextLayer: (textLayerDiv: HTMLDivElement | null) => { div: HTMLDivElement } | undefined;
    wrapUiManager: <T extends object | null>(uiManager: T) => T;
    wrapEditorLayer: <T extends IPdfAnnotationEditorLayerLike>(layer: T) => T;
}

interface IPdfAnnotationEditorCompatibilityRuntime {
    version?: unknown;
    AnnotationEditorLayer?: unknown;
    AnnotationEditorUIManager?: unknown;
}

interface ICreatePdfAnnotationEditorCompatibilityAdapterOptions {
    failInDev?: boolean | undefined;
    logger?: Pick<typeof BrowserLogger, 'warn' | 'debug'> | undefined;
    runtime: IPdfAnnotationEditorCompatibilityRuntime;
}

interface IRuntimeLike {prototype?: unknown;}

interface ILayerCompatibilityProto {__evbLayerCompatibilityPatched?: boolean;}

const wrappedUiManagers = new WeakSet<object>();
const wrappedEditorLayers = new WeakSet<object>();
let destroyedEditorLayerFallbackDiv: HTMLDivElement | null = null;
let missingCurrentEditorLayerFallback: Record<string, unknown> | null = null;
let didLogUnsupportedCompatibility = false;

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function getRuntimeVersion(runtime: IPdfAnnotationEditorCompatibilityRuntime) {
    return typeof runtime.version === 'string' && runtime.version.trim().length > 0
        ? runtime.version.trim()
        : 'unknown';
}

function getPrototype(value: unknown) {
    if (!isObjectLike(value)) {
        return null;
    }
    const candidate = (value as IRuntimeLike).prototype;
    return isObjectLike(candidate) ? candidate : null;
}

function getPrototypeMethodDescriptor(
    runtime: IPdfAnnotationEditorCompatibilityRuntime,
    exportName: 'AnnotationEditorLayer' | 'AnnotationEditorUIManager',
    method: string,
) {
    const prototype = getPrototype(runtime[exportName]);
    if (!prototype) {
        return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    return typeof descriptor?.value === 'function'
        ? descriptor
        : null;
}

function getCurrentLayerDescriptor(runtime: IPdfAnnotationEditorCompatibilityRuntime) {
    const prototype = getPrototype(runtime.AnnotationEditorUIManager);
    if (!prototype) {
        return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'currentLayer');
    return typeof descriptor?.get === 'function'
        ? descriptor
        : null;
}

function canPatchMethodDescriptor(descriptor: PropertyDescriptor | null) {
    return Boolean(descriptor && (descriptor.writable === true || descriptor.configurable === true));
}

function canPatchAccessorDescriptor(descriptor: PropertyDescriptor | null) {
    return Boolean(descriptor?.configurable === true);
}

function createFallbackDiv() {
    if (destroyedEditorLayerFallbackDiv) {
        return destroyedEditorLayerFallbackDiv;
    }
    if (typeof document === 'undefined') {
        return null;
    }
    const fallbackDiv = document.createElement('div');
    fallbackDiv.className = 'annotation-editor-layer-destroyed-fallback';
    fallbackDiv.style.display = 'none';
    fallbackDiv.setAttribute('aria-hidden', 'true');
    destroyedEditorLayerFallbackDiv = fallbackDiv;
    return fallbackDiv;
}

function getMissingCurrentEditorLayerFallback() {
    if (missingCurrentEditorLayerFallback) {
        return missingCurrentEditorLayerFallback;
    }
    const fallbackDiv = createFallbackDiv();
    if (!fallbackDiv) {
        return null;
    }
    missingCurrentEditorLayerFallback = {
        pageIndex: -1,
        div: fallbackDiv,
        hasTextLayer: () => false,
        canCreateNewEmptyEditor: () => false,
        addNewEditor: () => undefined,
        createAndAddNewEditor: () => null,
        toggleDrawing: () => undefined,
        deserialize: () => Promise.resolve(null),
        pasteEditor: () => undefined,
        endDrawingSession: () => null,
        pause: () => undefined,
        disable: () => undefined,
        enable: () => Promise.resolve(undefined),
        update: () => undefined,
        destroy: () => undefined,
    };
    return missingCurrentEditorLayerFallback;
}

function ensureLayerDiv(layer: IPdfAnnotationEditorLayerLike) {
    const fallbackDiv = createFallbackDiv();
    if (layer.div == null && fallbackDiv) {
        layer.div = fallbackDiv;
    }
}

function getCompatibilityProbeFailures(runtime: IPdfAnnotationEditorCompatibilityRuntime) {
    const failures: string[] = [];
    if (typeof runtime.AnnotationEditorLayer !== 'function') {
        failures.push('AnnotationEditorLayer export is not a constructor');
    }
    if (typeof runtime.AnnotationEditorUIManager !== 'function') {
        failures.push('AnnotationEditorUIManager export is not a constructor');
    }

    const disableDescriptor = getPrototypeMethodDescriptor(runtime, 'AnnotationEditorLayer', 'disable');
    if (!disableDescriptor) {
        failures.push('AnnotationEditorLayer.disable is missing');
    } else if (!canPatchMethodDescriptor(disableDescriptor)) {
        failures.push('AnnotationEditorLayer.disable is not patchable');
    }

    const destroyDescriptor = getPrototypeMethodDescriptor(runtime, 'AnnotationEditorLayer', 'destroy');
    if (!destroyDescriptor) {
        failures.push('AnnotationEditorLayer.destroy is missing');
    } else if (!canPatchMethodDescriptor(destroyDescriptor)) {
        failures.push('AnnotationEditorLayer.destroy is not patchable');
    }

    const currentLayerDescriptor = getCurrentLayerDescriptor(runtime);
    if (!currentLayerDescriptor) {
        failures.push('AnnotationEditorUIManager.currentLayer getter is missing');
    } else if (!canPatchAccessorDescriptor(currentLayerDescriptor)) {
        failures.push('AnnotationEditorUIManager.currentLayer is not configurable');
    }

    return failures;
}

export function getPdfAnnotationEditorCompatibilityProbeFailures(
    runtime: IPdfAnnotationEditorCompatibilityRuntime,
) {
    return getCompatibilityProbeFailures(runtime);
}

function buildReport(runtime: IPdfAnnotationEditorCompatibilityRuntime): IPdfAnnotationEditorCompatibilityReport {
    const failures = getCompatibilityProbeFailures(runtime);
    return {
        pdfjsVersion: getRuntimeVersion(runtime),
        severity: failures.length > 0 ? 'unsupported' : 'patched',
        appliedPatches: failures.length > 0
            ? []
            : [
                'annotation-editor-layer-div-fallback',
                'annotation-editor-ui-current-layer-fallback',
                'annotation-editor-text-layer-div-ref',
            ],
        failures,
    };
}

function patchUiManagerPrototype(
    runtime: IPdfAnnotationEditorCompatibilityRuntime,
    descriptor: PropertyDescriptor,
) {
    const prototype = getPrototype(runtime.AnnotationEditorUIManager);
    if (!prototype || prototype.__evbCurrentLayerCompatibilityPatched) {
        return false;
    }
    const originalGetter = descriptor.get;
    if (typeof originalGetter !== 'function') {
        return false;
    }
    Object.defineProperty(prototype, 'currentLayer', {
        ...descriptor,
        get() {
            const layer = originalGetter.call(this) as unknown;
            return layer ?? getMissingCurrentEditorLayerFallback();
        },
    });
    prototype.__evbCurrentLayerCompatibilityPatched = true;
    return true;
}

function patchEditorLayerPrototype(runtime: IPdfAnnotationEditorCompatibilityRuntime) {
    const prototype = getPrototype(runtime.AnnotationEditorLayer) as
        | (IPdfAnnotationEditorLayerLike & ILayerCompatibilityProto)
        | null;
    if (!prototype || prototype.__evbLayerCompatibilityPatched) {
        return false;
    }
    const originalDisable = prototype.disable;
    const originalDestroy = prototype.destroy;
    if (typeof originalDisable !== 'function' || typeof originalDestroy !== 'function') {
        return false;
    }
    prototype.disable = function patchedDisable(
        this: IPdfAnnotationEditorLayerLike,
        ...args: unknown[]
    ) {
        ensureLayerDiv(this);
        return originalDisable.call(this, ...args);
    };
    prototype.destroy = function patchedDestroy(
        this: IPdfAnnotationEditorLayerLike,
        ...args: unknown[]
    ) {
        ensureLayerDiv(this);
        const result = originalDestroy.call(this, ...args);
        ensureLayerDiv(this);
        return result;
    };
    prototype.__evbLayerCompatibilityPatched = true;
    return true;
}

function defineInstanceMethod<T extends IPdfAnnotationEditorLayerLike>(
    layer: T,
    method: 'disable' | 'destroy',
) {
    const originalMethod = layer[method];
    if (typeof originalMethod !== 'function') {
        return false;
    }
    const wrappedMethod = method === 'disable'
        ? function wrappedDisable(this: IPdfAnnotationEditorLayerLike, ...args: unknown[]) {
            ensureLayerDiv(this);
            return originalMethod.call(this, ...args);
        }
        : function wrappedDestroy(this: IPdfAnnotationEditorLayerLike, ...args: unknown[]) {
            ensureLayerDiv(this);
            const result = originalMethod.call(this, ...args);
            ensureLayerDiv(this);
            return result;
        };
    Object.defineProperty(layer, method, {
        configurable: true,
        writable: true,
        value: wrappedMethod,
    });
    return true;
}

export function createPdfAnnotationEditorCompatibilityAdapter(
    options: ICreatePdfAnnotationEditorCompatibilityAdapterOptions,
): IPdfAnnotationEditorCompatibilityAdapter {
    const report = buildReport(options.runtime);
    const logger = options.logger ?? BrowserLogger;
    if (report.severity === 'unsupported') {
        const message = `PDF.js annotation editor compatibility is unsupported for pdfjs-dist ${report.pdfjsVersion}: ${report.failures.join('; ')}`;
        if (options.failInDev === true) {
            throw new Error(message);
        }
        if (!didLogUnsupportedCompatibility) {
            didLogUnsupportedCompatibility = true;
            logger.warn('pdfjs-compatibility', message, { failures: report.failures });
        }
    }

    const currentLayerDescriptor = getCurrentLayerDescriptor(options.runtime);

    return {
        report,
        normalizeTextLayer: (textLayerDiv) => {
            if (!textLayerDiv) {
                return undefined;
            }
            try {
                (textLayerDiv as HTMLDivElement & {div?: HTMLDivElement}).div = textLayerDiv;
            } catch {
                return { div: textLayerDiv };
            }
            return { div: textLayerDiv };
        },
        wrapUiManager: (uiManager) => {
            if (!uiManager || report.severity === 'unsupported') {
                return uiManager;
            }
            if (wrappedUiManagers.has(uiManager)) {
                return uiManager;
            }
            if (!currentLayerDescriptor?.get) {
                return uiManager;
            }
            try {
                Object.defineProperty(uiManager, 'currentLayer', {
                    configurable: true,
                    get() {
                        const layer = currentLayerDescriptor.get?.call(uiManager) as unknown;
                        return layer ?? getMissingCurrentEditorLayerFallback();
                    },
                });
            } catch (error) {
                try {
                    patchUiManagerPrototype(options.runtime, currentLayerDescriptor);
                } catch (patchError) {
                    logger.debug('pdfjs-compatibility', 'Failed to wrap annotation editor UI manager currentLayer', {
                        error,
                        patchError,
                    });
                }
            }
            wrappedUiManagers.add(uiManager);
            return uiManager;
        },
        wrapEditorLayer: (layer) => {
            if (report.severity === 'unsupported' || wrappedEditorLayers.has(layer)) {
                return layer;
            }
            try {
                defineInstanceMethod(layer, 'disable');
                defineInstanceMethod(layer, 'destroy');
            } catch (error) {
                try {
                    patchEditorLayerPrototype(options.runtime);
                } catch (patchError) {
                    logger.debug('pdfjs-compatibility', 'Failed to wrap annotation editor layer teardown', {
                        error,
                        patchError,
                    });
                }
            }
            wrappedEditorLayers.add(layer);
            return layer;
        },
    };
}
