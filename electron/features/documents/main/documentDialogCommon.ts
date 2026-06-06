import {
    BrowserWindow,
    dialog,
} from 'electron';
import { extname } from 'path';
import { te } from '@electron/te';

interface IOpenDocumentDialogOptions {
    title: string;
    extensions: string[];
}

interface ISaveDialogOptions {
    title: string;
    defaultPath: string;
    filterName: string;
    extension: string;
}

export function getDialogParentWindow(event: Electron.IpcMainInvokeEvent) {
    return BrowserWindow.fromWebContents(event.sender);
}

export function errorWithDetails(fallbackMessage: string, details: unknown): Error {
    const detailText = details instanceof Error ? details.message : String(details ?? '').trim();
    if (!detailText) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage}: ${detailText}`);
}

export async function showOpenDocumentDialog(
    event: Electron.IpcMainInvokeEvent,
    options: IOpenDocumentDialogOptions,
) {
    const parentWindow = getDialogParentWindow(event);
    const dialogOptions = {
        title: options.title,
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: options.extensions,
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    } satisfies Electron.OpenDialogOptions;

    return parentWindow
        ? dialog.showOpenDialog(parentWindow, dialogOptions)
        : dialog.showOpenDialog(dialogOptions);
}

export async function showSaveDialogWithExtension(
    event: Electron.IpcMainInvokeEvent,
    options: ISaveDialogOptions,
) {
    const parentWindow = getDialogParentWindow(event);
    const dialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: [{
            name: options.filterName,
            extensions: [options.extension],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return null;
    }

    const extension = `.${options.extension}`;
    return extname(result.filePath).toLowerCase() === extension
        ? result.filePath
        : `${result.filePath}${extension}`;
}
