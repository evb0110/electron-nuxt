import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IGuestClock } from '@scripts/windows-test/guest/guestRuntime';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import {
    cancelPrintDialog,
    confirmPrintDialog,
    findDialogWindow,
    modernNativeDialogRecordIds,
    nativeDialogRecordIds,
    selectPrintToPdfPrinter,
    waitForDialogWindowToClose,
    waitForDialogWindow,
} from '@scripts/windows-test/guest/cases/nativeDialogs';
import {
    createNativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import {
    loadSelectorRecords,
    requireControlSelector,
} from '@scripts/windows-test/guest/native-ui/selectorRecords';

const modernWindow: IUiElementRef = {
    handle: 'modern-print-window',
    controlType: 'Window',
    name: 'EVB Viewer - Print',
    automationId: null,
    processId: 4242,
};

const legacyWindow: IUiElementRef = {
    handle: 'legacy-print-window',
    controlType: 'Window',
    name: 'Print',
    automationId: null,
    processId: 4242,
};

const modernPrinterList: IUiElementRef = {
    handle: 'modern-printer-list',
    controlType: 'ComboBox',
    name: 'Printer',
    automationId: 'printerSelector',
    processId: 4242,
};

const modernPrintButton: IUiElementRef = {
    handle: 'modern-print-button',
    controlType: 'Button',
    name: 'Print',
    automationId: 'PrintButton',
    processId: 4242,
};

const legacyPrinterList: IUiElementRef = {
    handle: 'legacy-printer-list',
    controlType: 'List',
    name: 'Select Printer',
    automationId: null,
    processId: 4242,
};

const legacyPrintButton: IUiElementRef = {
    handle: 'legacy-print-button',
    controlType: 'Button',
    name: 'Print',
    automationId: '1',
    processId: 4242,
};

const testClock: IGuestClock = {
    now: () => 0,
    nowIso: () => '2026-09-05T00:00:00.000Z',
    sleep: () => Promise.resolve(),
};

function contextFor(nativeUi: INativeUiAdapter, clock: IGuestClock = testClock) {
    return {
        selectors: loadSelectorRecords(),
        nativeUi,
        clock,
    } as ICaseContext;
}

function baseAdapter(overrides: Partial<INativeUiAdapter>): INativeUiAdapter {
    return {
        driver: 'uia3',
        actionLog: createNativeUiActionLog(),
        findWindow: async () => null,
        findControl: async () => [],
        invoke: async () => undefined,
        setValue: async () => undefined,
        select: async () => undefined,
        sendKeys: async () => undefined,
        waitFor: async () => modernPrintButton,
        captureTree: async () => ({}),
        screenshot: async () => undefined,
        ...overrides,
    };
}

describe('native print dialog records', () => {
    it('uses the verified modern print window and controls', async () => {
        const selected: Array<{
            ref: IUiElementRef;
            item: string;
        }> = [];
        const invoked: IUiElementRef[] = [];
        const windowQueries: IUiWindowQuery[] = [];
        const controlSelectors: IUiSelector[] = [];
        const nativeUi = baseAdapter({
            findWindow: async query => {
                windowQueries.push(query);
                return query.className === 'ApplicationFrameWindow' ? modernWindow : null;
            },
            findControl: async (_windowRef, selector) => {
                controlSelectors.push(selector);
                if (selector.automationId === 'printerSelector') {
                    return [modernPrinterList];
                }
                if (selector.automationId === 'PrintButton') {
                    return [modernPrintButton];
                }
                return [];
            },
            select: async (ref, item) => {
                selected.push({
                    ref,
                    item,
                });
            },
            invoke: async ref => {
                invoked.push(ref);
            },
        });
        const context = contextFor(nativeUi);

        const windowRef = await waitForDialogWindow(context, nativeDialogRecordIds.printDialog, 1_000);
        await selectPrintToPdfPrinter(context, windowRef, 1_000);
        await confirmPrintDialog(context, windowRef, 1_000);

        expect(windowRef).toBe(modernWindow);
        expect(windowQueries[0]).toEqual({
            className: 'ApplicationFrameWindow',
            titleContains: 'EVB Viewer - Print',
        });
        expect(controlSelectors.map(selector => selector.automationId)).toEqual([
            'printerSelector',
            'PrintButton',
        ]);
        expect(selected).toEqual([{
            ref: modernPrinterList,
            item: 'Microsoft Print to PDF',
        }]);
        expect(invoked).toEqual([modernPrintButton]);
    });

    it('falls back to the legacy print records when the modern tree is absent', async () => {
        const selected: Array<{
            ref: IUiElementRef;
            item: string;
        }> = [];
        const invoked: IUiElementRef[] = [];
        const windowQueries: IUiWindowQuery[] = [];
        const controlSelectors: IUiSelector[] = [];
        const nativeUi = baseAdapter({
            findWindow: async query => {
                windowQueries.push(query);
                return query.className === '#32770' ? legacyWindow : null;
            },
            findControl: async (_windowRef, selector) => {
                controlSelectors.push(selector);
                if (selector.controlType === 'List') {
                    return [legacyPrinterList];
                }
                if (selector.automationId === '1') {
                    return [legacyPrintButton];
                }
                return [];
            },
            select: async (ref, item) => {
                selected.push({
                    ref,
                    item,
                });
            },
            invoke: async ref => {
                invoked.push(ref);
            },
        });
        const context = contextFor(nativeUi);

        const windowRef = await findDialogWindow(context, nativeDialogRecordIds.printDialog);
        expect(windowRef).toBe(legacyWindow);
        await selectPrintToPdfPrinter(context, windowRef!, 1_000);
        await confirmPrintDialog(context, windowRef!, 1_000);

        expect(windowQueries.map(query => query.className)).toEqual([
            'ApplicationFrameWindow',
            '#32770',
        ]);
        expect(controlSelectors.map(selector => selector.automationId)).toEqual([
            'printerSelector',
            undefined,
            'PrintButton',
            '1',
        ]);
        expect(selected).toEqual([{
            ref: legacyPrinterList,
            item: 'Microsoft Print to PDF',
        }]);
        expect(invoked).toEqual([legacyPrintButton]);
    });

    it('checks both modern and legacy windows before declaring the print dialog closed', async () => {
        const windowQueries: IUiWindowQuery[] = [];
        const nativeUi = baseAdapter({ findWindow: async query => {
            windowQueries.push(query);
            return null;
        } });
        const context = contextFor(nativeUi);

        await expect(waitForDialogWindowToClose(context, nativeDialogRecordIds.printDialog, 1_000))
            .resolves.toBe(true);

        expect(windowQueries).toEqual([
            {
                className: 'ApplicationFrameWindow',
                titleContains: 'EVB Viewer - Print',
            },
            {
                className: '#32770',
                titleContains: 'Print',
            },
        ]);
    });

    it('returns false when the dialog remains open through the timeout budget', async () => {
        let now = 0;
        const nativeUi = baseAdapter({findWindow: async () => modernWindow});
        const clock: IGuestClock = {
            now: () => now,
            nowIso: () => '2026-09-05T00:00:00.000Z',
            sleep: async milliseconds => {
                now += milliseconds;
            },
        };

        await expect(waitForDialogWindowToClose(
            contextFor(nativeUi, clock),
            nativeDialogRecordIds.printDialog,
            500,
        )).resolves.toBe(false);
        expect(now).toBeGreaterThanOrEqual(500);
    });

    it('uses the modern cancel record when a caller closes the dialog', async () => {
        const invoked: IUiElementRef[] = [];
        const controlSelectors: IUiSelector[] = [];
        const nativeUi = baseAdapter({
            findControl: async (_windowRef, selector) => {
                controlSelectors.push(selector);
                return selector.automationId === 'CloseButton' ? [{
                    handle: 'modern-cancel-button',
                    controlType: 'Button',
                    name: 'Cancel',
                    automationId: 'CloseButton',
                    processId: 4242,
                }] : [];
            },
            invoke: async ref => {
                invoked.push(ref);
            },
        });

        await cancelPrintDialog(contextFor(nativeUi), modernWindow, 1_000);

        expect(controlSelectors).toEqual([requireControlSelector(
            loadSelectorRecords(),
            modernNativeDialogRecordIds.cancelPrintButton,
        )]);
        expect(invoked).toEqual([{
            handle: 'modern-cancel-button',
            controlType: 'Button',
            name: 'Cancel',
            automationId: 'CloseButton',
            processId: 4242,
        }]);
    });
});
