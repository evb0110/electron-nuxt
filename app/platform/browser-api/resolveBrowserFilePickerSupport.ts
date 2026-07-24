import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';

interface IWindowWithBrowserFilePickers extends Window {
    showOpenFilePicker?: (
        options?: {
            multiple?: boolean;
            excludeAcceptAllOption?: boolean;
            types?: IFilePickerAcceptType[];
        },
    ) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (
        options?: {
            suggestedName?: string;
            excludeAcceptAllOption?: boolean;
            types?: IFilePickerAcceptType[];
        },
    ) => Promise<FileSystemFileHandle>;
}

export interface IBrowserFilePickerSupport {
    openFilePicker: NonNullable<IWindowWithBrowserFilePickers['showOpenFilePicker']> | null;
    saveFilePicker: NonNullable<IWindowWithBrowserFilePickers['showSaveFilePicker']> | null;
}

export function resolveBrowserFilePickerSupport(): IBrowserFilePickerSupport {
    const pickerWindow = typeof window === 'undefined'
        ? null
        : (window as IWindowWithBrowserFilePickers);

    return {
        openFilePicker: typeof pickerWindow?.showOpenFilePicker === 'function'
            ? pickerWindow.showOpenFilePicker.bind(pickerWindow)
            : null,
        saveFilePicker: typeof pickerWindow?.showSaveFilePicker === 'function'
            ? pickerWindow.showSaveFilePicker.bind(pickerWindow)
            : null,
    };
}
