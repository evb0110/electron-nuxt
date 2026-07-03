import type { TLocale } from '@i18n-core';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { IPdfBox as IPdfGeometryBox } from '@contracts/geometry';
import { isRecord } from '@contracts/runtimeGuards';

export type {
    IPageGeometry,
    IPdfBox,
} from '@contracts/geometry';

export function normalizeNonEmptyStringPaths(paths: readonly unknown[]): string[] {
    const normalizedPaths: string[] = [];
    for (const path of paths) {
        if (typeof path !== 'string') {
            continue;
        }

        const trimmedPath = path.trim();
        if (trimmedPath.length > 0) {
            normalizedPaths.push(trimmedPath);
        }
    }

    return normalizedPaths;
}

export interface IRecentFile {
    originalPath: TDocumentRef;
    backend?: TDocumentBackend;
    fileName: string;
    timestamp: number;
    fileSize?: number;
}

export interface IOcrLanguage {
    code: string;
    script: 'latin' | 'cyrillic' | 'greek' | 'rtl';
}

export interface IOcrWord extends IPdfGeometryBox {text: string;}

export function isOcrWord(value: unknown): value is IOcrWord {
    return isRecord(value)
        && typeof value.text === 'string'
        && typeof value.x === 'number'
        && typeof value.y === 'number'
        && typeof value.width === 'number'
        && typeof value.height === 'number'
        && Number.isFinite(value.x)
        && Number.isFinite(value.y)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height);
}

export type TFitMode = 'width' | 'height';
export type TZoomMode = 'custom' | 'fit-width' | 'fit-height';
export type TPdfViewMode = 'single' | 'facing' | 'facing-first-single';
export type TDefaultZoomPreset = 'fit-width' | 'fit-height' | '100' | '125' | '150';

export type TAppTheme = 'light' | 'dark';
export type TAppLocale = TLocale;
export type TUiScalePreference = 'auto' | 'compact' | 'default' | 'comfortable' | 'large';
export type TTabMemoryPolicy = 'conservative' | 'aggressive';

export interface ISettingsData {
    version: number;
    authorName: string;
    theme: TAppTheme;
    locale: TAppLocale;
    defaultZoomPreset: TDefaultZoomPreset;
    defaultViewMode: TPdfViewMode;
    defaultContinuousScroll: boolean;
    defaultAnnotationColor: string;
    uiScale: TUiScalePreference;
    tabMemoryPolicy: TTabMemoryPolicy;
    optimizePdfOnSaveAs: boolean;
    assistantPanelEnabled: boolean;
    agentMcpEnabled: boolean;
    suppressDefaultViewerPrompt?: boolean;
    skippedUpdateVersion?: string;
}

export interface ICropMargins {
    top: number;
    bottom: number;
    left: number;
    right: number;
}
