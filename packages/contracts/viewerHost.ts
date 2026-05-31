import type { TDocumentRef } from '@contracts/document';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    TOpenFileResult,
} from '@contracts/electronApi';
import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
} from '@contracts/search';
import type { ISettingsData } from '@contracts/shared';
import type {
    IWindowTabTargetWindow,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
} from '@contracts/windowTabs';

export type TViewerHostKind = 'electron' | 'browser' | 'rn-webview';

export interface IViewerHostEnvironment {
    kind: TViewerHostKind;
    isMobile: boolean;
    isStandalone?: boolean;
    safeAreaInsets?: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
}

export interface IViewerAssetResolver {
    pdfWorkerUrl(): string;
    pdfAssetUrl(path: string): string;
    standardFontUrl(fileName: string): string;
}

export interface IViewerDocumentReadCapability {
    stat(ref: TDocumentRef): Promise<{ size: number }>;
    read(ref: TDocumentRef): Promise<Uint8Array>;
    readRange(ref: TDocumentRef, offset: number, length: number): Promise<Uint8Array>;
}

export interface IViewerDocumentPickerCapability {
    pickDocument?: () => Promise<TOpenFileResult | null>;
    openRecent?: (ref: TDocumentRef) => Promise<TOpenFileResult | null>;
}

export interface IViewerDocumentOutputCapability {
    save?: (ref: TDocumentRef, bytes: Uint8Array) => Promise<TDocumentRef | null>;
    saveAs?: (suggestedName: string, bytes: Uint8Array) => Promise<TDocumentRef | null>;
    share?: (suggestedName: string, bytes: Uint8Array) => Promise<void>;
}

export interface IViewerDocumentCapability extends
    IViewerDocumentReadCapability,
    IViewerDocumentPickerCapability,
    IViewerDocumentOutputCapability {}

export interface IViewerSearchCapability {
    run: (
        ref: TDocumentRef,
        query: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<IPdfSearchResponse>;
    warmIndex?: (
        ref: TDocumentRef,
        options?: IPdfSearchRequestOptions,
    ) => Promise<boolean>;
    cancel?: (requestId?: string) => Promise<{ canceled: boolean }>;
    onProgress?: (callback: (progress: IPdfSearchProgress) => void) => IMenuEventUnsubscribe;
}

export interface IViewerSettingsCapability {
    get(): Promise<ISettingsData>;
    save(settings: Partial<ISettingsData>): Promise<void>;
}

export interface IViewerHostApi {
    environment: IViewerHostEnvironment;
    assets: IViewerAssetResolver;
    documents: IViewerDocumentCapability;
    search: IViewerSearchCapability;
    settings: IViewerSettingsCapability;
    shell: { openExternal(url: string): Promise<void> };
}

export interface IDesktopMenuCapability {
    setMenuDocumentState(state: boolean | {
        hasDocument: boolean;
        canSave: boolean 
    }): Promise<void>;
    setMenuTabCount(tabCount: number): Promise<void>;
    onMenuOpenPdf(callback: IMenuEventCallback): IMenuEventUnsubscribe;
    onMenuSave(callback: IMenuEventCallback): IMenuEventUnsubscribe;
    onMenuSaveAs(callback: IMenuEventCallback): IMenuEventUnsubscribe;
    onMenuPrint(callback: IMenuEventCallback): IMenuEventUnsubscribe;
    onMenuPrintCurrentPage(callback: IMenuEventCallback): IMenuEventUnsubscribe;
}

export interface IDesktopWindowCapability {
    closeCurrentWindow(): Promise<boolean>;
    listTargetWindows(): Promise<IWindowTabTargetWindow[]>;
    transfer(request: IWindowTabTransferRequest): Promise<IWindowTabTransferResult>;
}
