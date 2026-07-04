import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IPageOpsMutationOptions } from '@contracts/electronApiPageOps';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import { createPageOpsService } from '@electron/features/page-ops/createPageOpsService';
import type { IPageOpsService } from '@electron/features/page-ops/ports';
import type { IValidatedIpcMainRegistrar } from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    decodeOptionalObjectWithKeys,
    decodeOptionalStringArg,
    decodePositiveIntegerArrayArg,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';

export type TPageOpsIpcMainRegistrar =
    IContractIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>
    | IValidatedIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>;

function createPageOpsOperationContext(event: IpcMainInvokeEvent) {
    return {
        sender: event.sender,
        senderId: event.sender.id,
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

function decodePageOpsMutationOptions(value: unknown): IPageOpsMutationOptions | undefined {
    const options = decodeOptionalObjectWithKeys(value, 'options', ['expectedDocumentRevisionToken']);
    if (
        options?.expectedDocumentRevisionToken !== undefined
        && options.expectedDocumentRevisionToken !== null
        && typeof options.expectedDocumentRevisionToken !== 'string'
    ) {
        throw new Error('options.expectedDocumentRevisionToken must be a string or null');
    }
    return options;
}

function decodeCropMargins(value: unknown) {
    const margins = decodeOptionalObjectWithKeys(value, 'margins', [
        'top',
        'bottom',
        'left',
        'right',
    ]);
    if (!margins) {
        throw new Error('margins must be an object');
    }
    for (const key of [
        'top',
        'bottom',
        'left',
        'right',
    ] as const) {
        if (typeof margins[key] !== 'number' || !Number.isFinite(margins[key]) || margins[key] < 0) {
            throw new Error(`margins.${key} must be a non-negative finite number`);
        }
    }
    return margins as {
        top: number;
        bottom: number;
        left: number;
        right: number;
    };
}

export function registerPageOpsIpcAdapter(
    registrar: TPageOpsIpcMainRegistrar = ipcMain,
    service: IPageOpsService = createPageOpsService(),
) {
    registrar.handle(PAGE_OPS_CHANNELS.delete, (event, workingCopyPath, pages, totalPages, options) =>
        service.delete(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, options), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodePositiveIntegerArrayArg(args, 1, 'pages'),
        decodeSafeIntegerArg(args, 2, 'totalPages', 1),
        decodePageOpsMutationOptions(args[3]),
    ]});
    registrar.handle(PAGE_OPS_CHANNELS.extract, (event, workingCopyPath, pages) =>
        service.extract(createPageOpsOperationContext(event), workingCopyPath, pages), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodePositiveIntegerArrayArg(args, 1, 'pages'),
    ]});
    registrar.handle(PAGE_OPS_CHANNELS.reorder, (event, workingCopyPath, newOrder, options) =>
        service.reorder(createPageOpsOperationContext(event), workingCopyPath, newOrder, options), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodePositiveIntegerArrayArg(args, 1, 'newOrder'),
        decodePageOpsMutationOptions(args[2]),
    ]});
    registrar.handle(PAGE_OPS_CHANNELS.insert, (event, workingCopyPath, totalPages, afterPage, options) =>
        service.insert(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage, options), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodeSafeIntegerArg(args, 1, 'totalPages', 0),
        decodeSafeIntegerArg(args, 2, 'afterPage', 0),
        decodePageOpsMutationOptions(args[3]),
    ]});
    registrar.handle(
        PAGE_OPS_CHANNELS.insertFile,
        (event, workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options) =>
            service.insertFile(createPageOpsOperationContext(event), workingCopyPath, totalPages, afterPage, sourcePaths, requestId, options),
        {decode: args => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodeSafeIntegerArg(args, 1, 'totalPages', 0),
            decodeSafeIntegerArg(args, 2, 'afterPage', 0),
            decodeStringArrayArg(args, 3, 'sourcePaths'),
            decodeOptionalStringArg(args, 4, 'requestId'),
            decodePageOpsMutationOptions(args[5]),
        ]},
    );
    registrar.handle(PAGE_OPS_CHANNELS.rotate, (event, workingCopyPath, pages, totalPages, angle, options) =>
        service.rotate(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, angle, options), {decode: args => {
        const angle = decodeSafeIntegerArg(args, 4, 'angle', 0);
        if (angle !== 90 && angle !== 180 && angle !== 270) {
            throw new Error('angle must be 90, 180, or 270');
        }
        return [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
            decodeSafeIntegerArg(args, 2, 'totalPages', 1),
            angle,
            decodePageOpsMutationOptions(args[5]),
        ];
    }});
    registrar.handle(PAGE_OPS_CHANNELS.crop, (event, workingCopyPath, pages, totalPages, margins, options) =>
        service.crop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, margins, options), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodePositiveIntegerArrayArg(args, 1, 'pages'),
        decodeSafeIntegerArg(args, 2, 'totalPages', 1),
        decodeCropMargins(args[3]),
        decodePageOpsMutationOptions(args[4]),
    ]});
    registrar.handle(PAGE_OPS_CHANNELS.removeCrop, (event, workingCopyPath, pages, totalPages, options) =>
        service.removeCrop(createPageOpsOperationContext(event), workingCopyPath, pages, totalPages, options), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodePositiveIntegerArrayArg(args, 1, 'pages'),
        decodeSafeIntegerArg(args, 2, 'totalPages', 1),
        decodePageOpsMutationOptions(args[3]),
    ]});
    registrar.handle(PAGE_OPS_CHANNELS.getPageGeometry, (event, workingCopyPath, pageNumber) =>
        service.getPageGeometry(createPageOpsOperationContext(event), workingCopyPath, pageNumber), {decode: args => [
        decodeStringArg(args, 0, 'workingCopyPath'),
        decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
    ]});
}
