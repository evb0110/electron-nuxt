import {
    waitForUniqueControl,
    type IUiElementRef,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import {
    MICROSOFT_PRINT_TO_PDF_PRINTER,
    requireControlSelector,
    requireWindowQuery,
} from '@scripts/windows-test/guest/native-ui/selectorRecords';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';

export const nativeDialogRecordIds = {
    viewerWindow: 'evb-viewer.main-window',
    fileDialog: 'common-file-dialog.window',
    printOutputDialog: 'common-file-dialog.save-print-output-window',
    fileNameEdit: 'common-file-dialog.file-name-edit',
    commitButton: 'common-file-dialog.commit-button',
    cancelButton: 'common-file-dialog.cancel-button',
    fileTypeCombo: 'common-file-dialog.file-type-combo',
    overwriteWindow: 'common-file-dialog.overwrite-confirm-window',
    overwriteNoButton: 'common-file-dialog.overwrite-no-button',
    printDialog: 'print-dialog.window',
    printerList: 'print-dialog.printer-list',
    printToPdfEntry: 'print-dialog.microsoft-print-to-pdf',
    printButton: 'print-dialog.print-button',
    cancelPrintButton: 'print-dialog.cancel-button',
} as const;

const WINDOW_POLL_INTERVAL_MS = 250;

export async function findDialogWindow(context: ICaseContext, recordId: string) {
    return context.nativeUi.findWindow(requireWindowQuery(context.selectors, recordId));
}

export async function waitForDialogWindow(context: ICaseContext, recordId: string, timeoutMs: number) {
    const query = requireWindowQuery(context.selectors, recordId);
    const deadline = context.clock.now() + timeoutMs;
    for (;;) {
        const found = await context.nativeUi.findWindow(query);
        if (found !== null) {
            return found;
        }
        if (context.clock.now() >= deadline) {
            throw new Error(`Window ${recordId} did not appear within ${timeoutMs}ms`);
        }
        await context.clock.sleep(WINDOW_POLL_INTERVAL_MS);
    }
}

export async function waitForDialogWindowToClose(context: ICaseContext, recordId: string, timeoutMs: number) {
    const query = requireWindowQuery(context.selectors, recordId);
    const deadline = context.clock.now() + timeoutMs;
    for (;;) {
        if (await context.nativeUi.findWindow(query) === null) {
            return true;
        }
        if (context.clock.now() >= deadline) {
            return false;
        }
        await context.clock.sleep(WINDOW_POLL_INTERVAL_MS);
    }
}

export async function waitForDialogControl(
    context: ICaseContext,
    windowRef: IUiElementRef,
    recordId: string,
    timeoutMs: number,
) {
    return waitForUniqueControl({
        adapter: context.nativeUi,
        windowRef,
        selector: requireControlSelector(context.selectors, recordId),
        timeoutMs,
        sleep: milliseconds => context.clock.sleep(milliseconds),
        now: () => context.clock.now(),
    });
}

export async function fillFileDialogPath(
    context: ICaseContext,
    windowRef: IUiElementRef,
    filePath: string,
    timeoutMs: number,
) {
    const edit = await waitForDialogControl(context, windowRef, nativeDialogRecordIds.fileNameEdit, timeoutMs);
    await context.nativeUi.setValue(edit, filePath);
    return edit;
}

export async function commitFileDialog(context: ICaseContext, windowRef: IUiElementRef, timeoutMs: number) {
    const commit = await waitForDialogControl(context, windowRef, nativeDialogRecordIds.commitButton, timeoutMs);
    await context.nativeUi.invoke(commit);
}

export async function cancelFileDialog(context: ICaseContext, windowRef: IUiElementRef, timeoutMs: number) {
    const cancel = await waitForDialogControl(context, windowRef, nativeDialogRecordIds.cancelButton, timeoutMs);
    await context.nativeUi.invoke(cancel);
}

export interface ISaveThroughFileDialogOptions {
    windowRecordId?: string;
    filePath: string;
    timeoutMs: number;
}

export async function saveThroughFileDialog(context: ICaseContext, {
    windowRecordId = nativeDialogRecordIds.fileDialog,
    filePath,
    timeoutMs,
}: ISaveThroughFileDialogOptions) {
    const windowRef = await waitForDialogWindow(context, windowRecordId, timeoutMs);
    await fillFileDialogPath(context, windowRef, filePath, timeoutMs);
    await commitFileDialog(context, windowRef, timeoutMs);
    return windowRef;
}

const SEND_KEYS_SPECIAL_CHARACTERS = /[+^%~(){}[\]]/gu;

/**
 * SendKeys reads +, ^, %, ~, parentheses, braces and brackets as modifiers or
 * groups; wrapping each in braces types it literally, so a path such as
 * `C:\\Users\\a (1)\\x.pdf` arrives unchanged.
 */
export function escapeSendKeysText(text: string) {
    return text.replace(SEND_KEYS_SPECIAL_CHARACTERS, character => `{${character}}`);
}

export async function typeFilePathWithKeyboard(
    context: ICaseContext,
    windowRef: IUiElementRef,
    filePath: string,
) {
    await context.nativeUi.sendKeys(windowRef, escapeSendKeysText(filePath));
    await context.nativeUi.sendKeys(windowRef, '{ENTER}');
}

export async function refuseOverwrite(context: ICaseContext, timeoutMs: number) {
    const confirmWindow = await waitForDialogWindow(context, nativeDialogRecordIds.overwriteWindow, timeoutMs);
    const noButton = await waitForDialogControl(
        context,
        confirmWindow,
        nativeDialogRecordIds.overwriteNoButton,
        timeoutMs,
    );
    await context.nativeUi.invoke(noButton);
    return confirmWindow;
}

export async function selectPrintToPdfPrinter(
    context: ICaseContext,
    windowRef: IUiElementRef,
    timeoutMs: number,
) {
    const printerList = await waitForDialogControl(context, windowRef, nativeDialogRecordIds.printerList, timeoutMs);
    await context.nativeUi.select(printerList, MICROSOFT_PRINT_TO_PDF_PRINTER);
    return printerList;
}

export async function confirmPrintDialog(context: ICaseContext, windowRef: IUiElementRef, timeoutMs: number) {
    const printButton = await waitForDialogControl(context, windowRef, nativeDialogRecordIds.printButton, timeoutMs);
    await context.nativeUi.invoke(printButton);
}

export async function cancelPrintDialog(context: ICaseContext, windowRef: IUiElementRef, timeoutMs: number) {
    const cancelButton = await waitForDialogControl(
        context,
        windowRef,
        nativeDialogRecordIds.cancelPrintButton,
        timeoutMs,
    );
    await context.nativeUi.invoke(cancelButton);
}

export async function captureDialogEvidence(
    context: ICaseContext,
    windowRef: IUiElementRef,
    fileName: string,
) {
    const treePath = context.attachEvidence(`${fileName}.tree.json`);
    const tree = await context.nativeUi.captureTree(windowRef);
    await context.fs.writeText(treePath, JSON.stringify(tree, null, 4));
    const screenshotPath = context.attachEvidence(`${fileName}.png`);
    await context.nativeUi.screenshot(screenshotPath);
}

export async function cancelFileDialogIfPresent(context: ICaseContext, timeoutMs: number) {
    const dialog = await findDialogWindow(context, nativeDialogRecordIds.fileDialog);
    if (dialog === null) {
        return false;
    }
    await cancelFileDialog(context, dialog, timeoutMs);
    return true;
}
