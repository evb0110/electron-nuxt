import type { TLocale } from '@i18n-core';
import type { TDocumentRef } from './document';
import { isRecord } from './runtimeGuards';

export function normalizeNonEmptyStringPaths(paths: readonly unknown[]): string[] {
    return paths
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
}

export interface IRecentFile {
    originalPath: TDocumentRef;
    fileName: string;
    timestamp: number;
    fileSize?: number | undefined;
}

export interface IOcrLanguage {
    code: string;
    script: 'latin' | 'cyrillic' | 'greek' | 'rtl';
}

export interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

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
    suppressDefaultViewerPrompt?: boolean | undefined;
    skippedUpdateVersion?: string | undefined;
}

export interface ICropMargins {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export interface IPdfBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPageGeometry {
    mediaBox: IPdfBox;
    cropBox: IPdfBox | null;
    rotation: number;
}
