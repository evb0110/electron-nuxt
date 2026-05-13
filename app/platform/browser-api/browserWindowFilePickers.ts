import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';

interface IOpenFilePickerOptions {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: IFilePickerAcceptType[];
}

interface ISaveFilePickerOptions {
    suggestedName?: string;
    excludeAcceptAllOption?: boolean;
    types?: IFilePickerAcceptType[];
}

interface IWindowWithBrowserFilePickers extends Window {
    showOpenFilePicker?: (
        options?: IOpenFilePickerOptions,
    ) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (
        options?: ISaveFilePickerOptions,
    ) => Promise<FileSystemFileHandle>;
}

function getWindowWithPickers() {
    if (typeof window === 'undefined') {
        return null;
    }

    return window as IWindowWithBrowserFilePickers;
}

export { getWindowWithPickers };
