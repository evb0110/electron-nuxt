import type { TLocale } from '@i18n-core';

export interface IRecentFile {
    originalPath: string;
    fileName: string;
    timestamp: number;
    fileSize?: number;
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

export type TFitMode = 'width' | 'height';
export type TZoomMode = 'custom' | 'fit-width' | 'fit-height';
export type TPdfViewMode = 'single' | 'facing' | 'facing-first-single';
export type TDefaultZoomPreset = 'fit-width' | 'fit-height' | '100' | '125' | '150';

export type TAppTheme = 'light' | 'dark';
export type TAppLocale = TLocale;

export interface ISettingsData {
    version: number;
    authorName: string;
    theme: TAppTheme;
    locale: TAppLocale;
    defaultZoomPreset: TDefaultZoomPreset;
    defaultViewMode: TPdfViewMode;
    defaultContinuousScroll: boolean;
    defaultAnnotationColor: string;
    suppressDefaultViewerPrompt?: boolean;
    skippedUpdateVersion?: string;
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
