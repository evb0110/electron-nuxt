import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AmbiguousSelectorError,
    DesktopUnavailableError,
    describeUiSelector,
    resolveUniqueElement,
    SelectorNotFoundError,
    waitForUniqueControl,
    type IUiElementRef,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import {
    assertPinnedWinappCliVersion,
    createWinappCliAdapter,
    isDesktopUnavailableMessage,
    parseWinappInspectElements,
    parseWinappInspectPayload,
    parseWinappElements,
    parseWinappInvokePayload,
    parseWinappScreenshotPayload,
    parseWinappSearchPayload,
    parseWinappSendKeysPayload,
    parseWinappSetValuePayload,
    parseWinappVersion,
    parseWinappWindows,
    translateLegacySendKeys,
    UnsupportedWinappOperationError,
    WINAPP_EXPECTED_VERSION,
} from '@scripts/windows-test/guest/native-ui/winappCliAdapter';
import {
    createUia3PowerShellAdapter,
    parseUia3Elements,
} from '@scripts/windows-test/guest/native-ui/uia3PowerShellAdapter';
import type {
    IGuestCommandResult,
    IGuestCommandRunner,
    IGuestClock,
} from '@scripts/windows-test/guest/guestRuntime';
import type { IGuestPowerShellRunner } from '@scripts/windows-test/guest/guestPowerShell';

const testClock: IGuestClock = {
    now: () => 0,
    nowIso: () => '2026-09-04T12:00:00.000Z',
    sleep: () => Promise.resolve(),
};

function element(overrides: Partial<IUiElementRef> = {}): IUiElementRef {
    return {
        handle: '42.1',
        controlType: 'Button',
        name: 'Save',
        automationId: 'saveButton',
        processId: 4242,
        ...overrides,
    };
}

function scriptedExec(responses: readonly IGuestCommandResult[]) {
    const calls: Array<{
        command: string;
        args: readonly string[];
    }> = [];
    let index = 0;
    const exec: IGuestCommandRunner = { run: (command, args) => {
        calls.push({
            command,
            args,
        });
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Promise.resolve(response ?? {
            exitCode: 0,
            stdout: '[]',
            stderr: '',
        });
    } };
    return {
        calls,
        exec,
    };
}

function scriptedPowerShell(responses: readonly IGuestCommandResult[]) {
    const calls: Array<{
        scriptName: string;
        args: readonly string[];
    }> = [];
    let index = 0;
    const powerShell: IGuestPowerShellRunner = {
        scriptPath: scriptName => `C:\\evb-test\\worker\\powershell\\${scriptName}`,
        run: (scriptName, args = []) => {
            calls.push({
                scriptName,
                args,
            });
            const response = responses[Math.min(index, responses.length - 1)];
            index += 1;
            return Promise.resolve(response ?? {
                exitCode: 0,
                stdout: '[]',
                stderr: '',
            });
        },
        runJson: () => Promise.reject(new Error('runJson is not used by the UIA3 adapter')),
    };
    return {
        calls,
        powerShell,
    };
}

describe('selector resolution', () => {
    it('refuses to act on an ambiguous selector', () => {
        const selector = {
            controlType: 'Button',
            name: { exact: 'Save' },
        };
        expect(() => resolveUniqueElement([
            element(),
            element({ handle: '42.2' }),
        ], selector)).toThrow(AmbiguousSelectorError);
        expect(() => resolveUniqueElement([], selector)).toThrow(SelectorNotFoundError);
        expect(resolveUniqueElement([element()], selector).handle).toBe('42.1');
        expect(describeUiSelector(selector)).toContain('name=Save');
    });

    it('allows an explicit index to disambiguate a known list', () => {
        const selector = {
            controlType: 'ListItem',
            index: 1,
        };
        expect(resolveUniqueElement([
            element({ handle: 'a' }),
            element({ handle: 'b' }),
        ], selector).handle).toBe('b');
        expect(() => resolveUniqueElement([element()], selector)).toThrow(SelectorNotFoundError);
    });

    it('keeps polling for a control but never waits out an ambiguous match', async () => {
        let attempts = 0;
        const adapter = {findControl: () => {
            attempts += 1;
            return Promise.resolve(attempts < 3 ? [] : [element()]);
        }};
        let currentTime = 0;
        const found = await waitForUniqueControl({
            adapter: adapter as never,
            windowRef: element({ controlType: 'Window' }),
            selector: { controlType: 'Button' },
            timeoutMs: 5_000,
            sleep: () => {
                currentTime += 250;
                return Promise.resolve();
            },
            now: () => currentTime,
        });
        expect(found.handle).toBe('42.1');

        await expect(waitForUniqueControl({
            adapter: { findControl: () => Promise.resolve([
                element(),
                element({ handle: 'other' }),
            ]) } as never,
            windowRef: element({ controlType: 'Window' }),
            selector: { controlType: 'Button' },
            timeoutMs: 5_000,
            sleep: () => Promise.resolve(),
            now: () => 0,
        })).rejects.toBeInstanceOf(AmbiguousSelectorError);
    });
});

describe('winapp CLI adapter', () => {
    it('parses the source-backed search envelope and rejects invented shapes', () => {
        const match = {
            selector: 'btn-save-a1b2',
            type: 'Button',
            name: 'Save',
            automationId: 'saveButton',
            className: 'Button',
            isEnabled: true,
            isOffscreen: false,
            x: 10,
            y: 20,
            width: 80,
            height: 24,
            isInvokable: true,
        };
        const search = JSON.stringify({
            matchCount: 1,
            hasMore: false,
            matches: [match],
        });
        expect(parseWinappElements(search)).toEqual([{
            handle: 'btn-save-a1b2',
            controlType: 'Button',
            name: 'Save',
            automationId: 'saveButton',
            processId: null,
        }]);
        expect(parseWinappSearchPayload(JSON.stringify({
            matchCount: 0,
            hasMore: false,
            matches: [],
        }))).toEqual({
            matchCount: 0,
            hasMore: false,
            matches: [],
        });
        expect(() => parseWinappElements('[{"selector":"btn-save-a1b2","type":"Button"}]'))
            .toThrow('ui search result');
        expect(() => parseWinappElements('   ')).toThrow('empty output');
        expect(() => parseWinappElements('not json')).toThrow('not JSON');
        expect(() => parseWinappElements(JSON.stringify({
            matchCount: 1,
            hasMore: false,
            matches: [{
                type: 'Button',
                name: 'Save',
            }],
        }))).toThrow('without a semantic selector');
        expect(parseWinappInvokePayload(JSON.stringify({
            elementId: 'btn-save-a1b2',
            pattern: 'Invoke',
            hwnd: 9001,
        })).pattern).toBe('Invoke');
        expect(parseWinappSetValuePayload(JSON.stringify({
            elementId: 'edit-file-f00d',
            hwnd: 9001,
        })).elementId).toBe('edit-file-f00d');
        expect(parseWinappSendKeysPayload(JSON.stringify({
            keys: 'ctrl+s',
            via: 'post-message',
            actionCount: 2,
            hwnd: 9001,
            warnings: [],
        })).via).toBe('post-message');
        expect(parseWinappScreenshotPayload(JSON.stringify({
            filePath: 'C:\\evidence\\screen.png',
            width: 640,
            height: 480,
            processId: 4242,
            windowTitle: 'Save As',
            hwnd: 9001,
        })).filePath).toBe('C:\\evidence\\screen.png');
    });

    it('parses nested inspect output and the bare list-windows array', () => {
        const inspect = {
            depth: 4,
            interactive: false,
            hideDisabled: false,
            hideOffscreen: false,
            windows: [{
                hwnd: 9001,
                title: 'Save As',
                className: '#32770',
                elementCount: 2,
                elements: [{
                    selector: 'win-saveas-cafe',
                    type: 'Window',
                    name: 'Save As',
                    automationId: 'dialog',
                    children: [{
                        selector: 'edit-file-f00d',
                        type: 'Edit',
                        name: 'File name:',
                        automationId: 'FileNameControlHost',
                    }],
                }],
            }],
        };
        expect(parseWinappInspectPayload(JSON.stringify(inspect)).windows[0]?.hwnd).toBe(9001);
        expect(parseWinappInspectElements(JSON.stringify(inspect)).map(item => item.handle))
            .toEqual([
                'win-saveas-cafe',
                'edit-file-f00d',
            ]);
        expect(parseWinappWindows(JSON.stringify([{
            hwnd: 9001,
            processId: 4242,
            processName: 'evb-viewer',
            title: 'Save As',
            label: 'Save As',
            width: 640,
            height: 480,
            ownerHwnd: 0,
            className: '#32770',
            isForeground: true,
        }]))).toEqual([expect.objectContaining({
            hwnd: 9001,
            processId: 4242,
            title: 'Save As',
            className: '#32770',
        })]);
        expect(() => parseWinappWindows(JSON.stringify({ windows: [] })))
            .toThrow('ui list-windows result');
    });

    it('pins the CLI version the lane was validated against', async () => {
        expect(parseWinappVersion('winapp 0.6.0 (windows)')).toBe('0.6.0');
        expect(() => parseWinappVersion('unknown build')).toThrow('did not report a version');
        const pinned = scriptedExec([{
            exitCode: 0,
            stdout: `winapp ${WINAPP_EXPECTED_VERSION}`,
            stderr: '',
        }]);
        await expect(assertPinnedWinappCliVersion(pinned.exec)).resolves.toBe(WINAPP_EXPECTED_VERSION);
        const wrong = scriptedExec([{
            exitCode: 0,
            stdout: 'winapp 0.5.9',
            stderr: '',
        }]);
        await expect(assertPinnedWinappCliVersion(wrong.exec)).rejects.toThrow('the lane pins 0.6.0');
    });

    it('builds a ui search command and filters localized names and control type', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                matchCount: 3,
                hasMore: false,
                matches: [
                    {
                        selector: 'btn-save-a1b2',
                        type: 'Button',
                        name: 'Сохранить',
                        automationId: 'saveButton',
                    },
                    {
                        selector: 'edit-save-c3d4',
                        type: 'Edit',
                        name: 'Сохранить',
                        automationId: 'saveButton',
                    },
                    {
                        selector: 'btn-cancel-e5f6',
                        type: 'Button',
                        name: 'Cancel',
                    },
                ],
            }),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        const found = await adapter.findControl(element({
            handle: '9001',
            controlType: 'Window',
        }), {
            controlType: 'Button',
            automationId: 'saveButton',
            processId: 4242,
            name: {
                exact: 'Save',
                localizedFallbacks: ['Сохранить'],
            },
        });
        expect(found.map(candidate => candidate.handle)).toEqual(['btn-save-a1b2']);
        expect(scripted.calls[0]?.args).toEqual([
            'ui',
            'search',
            'saveButton',
            '--json',
            '--max',
            '1000',
            '--window',
            '9001',
        ]);
    });

    it('rejects a truncated search before claiming a control is unique', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                matchCount: 1_001,
                hasMore: true,
                matches: [{
                    selector: 'btn-save-a1b2',
                    type: 'Button',
                    name: 'Save',
                    automationId: 'saveButton',
                }],
            }),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.findControl(element({
            handle: '9001',
            controlType: 'Window',
        }), {
            controlType: 'Button',
            automationId: 'saveButton',
        })).rejects.toThrow(
            'ui search truncated its result set; the match list is not complete',
        );
    });

    it('skips irrelevant selectorless matches but fails closed for a matching one', async () => {
        const usable = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                matchCount: 2,
                hasMore: false,
                matches: [
                    {
                        type: 'Edit',
                        name: 'Save',
                        automationId: 'saveButton',
                    },
                    {
                        selector: 'btn-save-a1b2',
                        type: 'Button',
                        name: 'Save',
                        automationId: 'saveButton',
                    },
                ],
            }),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: usable.exec,
            clock: testClock,
        });
        await expect(adapter.findControl(element({
            handle: '9001',
            controlType: 'Window',
        }), {
            controlType: 'Button',
            automationId: 'saveButton',
        })).resolves.toHaveLength(1);

        const unaddressable = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                matchCount: 1,
                hasMore: false,
                matches: [{
                    type: 'Button',
                    name: 'Save',
                    automationId: 'saveButton',
                }],
            }),
            stderr: '',
        }]);
        const rejectingAdapter = createWinappCliAdapter({
            exec: unaddressable.exec,
            clock: testClock,
        });
        await expect(rejectingAdapter.findControl(element({
            handle: '9001',
            controlType: 'Window',
        }), {
            controlType: 'Button',
            automationId: 'saveButton',
        })).rejects.toThrow(
            'matching element without a semantic selector',
        );
    });

    it('fails closed when a selectorless list item could satisfy select', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                matchCount: 1,
                hasMore: false,
                matches: [{
                    type: 'ListItem',
                    name: 'Microsoft Print to PDF',
                }],
            }),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.select(element({
            handle: '9001',
            controlType: 'Window',
        }), 'Microsoft Print to PDF')).rejects.toThrow(
            'matching list item without a semantic selector',
        );
    });

    it('records every action it performs for the evidence trail', async () => {
        const scripted = scriptedExec([
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    elementId: 'btn-save-a1b2',
                    pattern: 'Invoke',
                    hwnd: 9001,
                }),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    elementId: 'edit-file-c3d4',
                    hwnd: 9001,
                }),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    keys: 'ctrl+s',
                    via: 'post-message',
                    actionCount: 2,
                    hwnd: 9001,
                    warnings: [],
                }),
                stderr: '',
            },
        ]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await adapter.invoke(element({ handle: 'btn-save-a1b2' }));
        await adapter.setValue(element({
            handle: 'edit-file-c3d4',
            controlType: 'Edit',
        }), 'C:\\out\\файл.pdf');
        await adapter.sendKeys(element({
            handle: '9001',
            controlType: 'Window',
        }), '^s');
        expect(adapter.actionLog.entries()).toEqual([
            {
                actionKind: 'pattern',
                action: 'invoke',
                target: 'btn-save-a1b2',
            },
            {
                actionKind: 'pattern',
                action: 'set-value',
                target: 'edit-file-c3d4',
            },
            {
                actionKind: 'input',
                action: 'send-keys',
                target: '9001',
            },
        ]);
        expect(scripted.calls.map(call => call.args)).toEqual([
            [
                'ui',
                'invoke',
                'btn-save-a1b2',
                '--json',
                '--app',
                '4242',
            ],
            [
                'ui',
                'set-value',
                'edit-file-c3d4',
                'C:\\out\\файл.pdf',
                '--json',
                '--app',
                '4242',
            ],
            [
                'ui',
                'send-keys',
                'ctrl+s',
                '--json',
                '--via',
                'post-message',
                '--window',
                '9001',
            ],
        ]);
        expect(adapter.driver).toBe('winapp');
    });

    it('translates the worker SendKeys notation into the WinApp grammar', () => {
        expect(translateLegacySendKeys('^o')).toBe('ctrl+o');
        expect(translateLegacySendKeys('^+s')).toBe('ctrl+shift+s');
        expect(translateLegacySendKeys('{ENTER}')).toBe('enter');
        expect(translateLegacySendKeys('C:\\out\\a {(}1{)}.pdf'))
            .toBe('text=C:\\\\out\\\\a\\s(1).pdf');
        expect(translateLegacySendKeys('down down enter')).toBe('down down enter');
    });

    it('turns a missing desktop into a typed failure rather than a generic one', async () => {
        expect(isDesktopUnavailableMessage('Cannot attach to WinSta0 from this session')).toBe(true);
        expect(isDesktopUnavailableMessage('element not found')).toBe(false);
        const scripted = scriptedExec([{
            exitCode: 1,
            stdout: '',
            stderr: 'no interactive desktop is attached to this session',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.findWindow({ titleContains: 'Save As' }))
            .rejects.toBeInstanceOf(DesktopUnavailableError);
    });

    it('reports no window rather than throwing when the query matches nothing', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: '[]',
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        expect(await adapter.findWindow({
            titleContains: 'Save As',
            className: '#32770',
            automationId: 'dialog',
            processId: 4242,
        })).toBeNull();
        expect(scripted.calls[0]?.args).toEqual([
            'ui',
            'list-windows',
            '--app',
            '4242',
            '--json',
        ]);
    });

    it('uses inspect for automationId window queries because list-windows has no automationId', async () => {
        const scripted = scriptedExec([
            {
                exitCode: 0,
                stdout: JSON.stringify([{
                    hwnd: 9001,
                    processId: 4242,
                    processName: 'evb-viewer',
                    title: 'Save As',
                    width: 640,
                    height: 480,
                    ownerHwnd: 0,
                    className: '#32770',
                    isForeground: true,
                }]),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    depth: 0,
                    interactive: false,
                    hideDisabled: false,
                    hideOffscreen: false,
                    windows: [{
                        hwnd: 9001,
                        title: 'Save As',
                        className: '#32770',
                        elementCount: 1,
                        elements: [{
                            selector: 'win-saveas-cafe',
                            type: 'Window',
                            name: 'Save As',
                            automationId: 'dialog',
                        }],
                    }],
                }),
                stderr: '',
            },
        ]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.findWindow({
            titleContains: 'save',
            automationId: 'dialog',
            processId: 4242,
        })).resolves.toEqual({
            handle: '9001',
            controlType: 'Window',
            name: 'Save As',
            automationId: 'dialog',
            processId: 4242,
        });
        expect(scripted.calls.map(call => call.args)).toEqual([
            [
                'ui',
                'list-windows',
                '--app',
                '4242',
                '--json',
            ],
            [
                'ui',
                'inspect',
                '--depth',
                '0',
                '--json',
                '--window',
                '9001',
            ],
        ]);
    });

    it('implements select with the supported search and invoke commands', async () => {
        const scripted = scriptedExec([
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    matchCount: 1,
                    hasMore: false,
                    matches: [{
                        selector: 'item-pdf-1234',
                        type: 'ListItem',
                        name: 'Microsoft Print to PDF',
                        automationId: 'MicrosoftPrintToPDF',
                    }],
                }),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    elementId: 'item-pdf-1234',
                    pattern: 'SelectionItem',
                    hwnd: 9001,
                }),
                stderr: '',
            },
        ]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await adapter.select(element({
            handle: '9001',
            controlType: 'Window',
            processId: null,
        }), 'Microsoft Print to PDF');
        expect(scripted.calls.map(call => call.args)).toEqual([
            [
                'ui',
                'search',
                'Microsoft Print to PDF',
                '--json',
                '--max',
                '1000',
                '--window',
                '9001',
            ],
            [
                'ui',
                'invoke',
                'item-pdf-1234',
                '--json',
                '--window',
                '9001',
            ],
        ]);
        expect(adapter.actionLog.entries()).toContainEqual({
            actionKind: 'pattern',
            action: 'select',
            target: '9001',
        });
    });

    it('keeps screenshot targeting on an explicit window after another control lookup', async () => {
        const scripted = scriptedExec([
            {
                exitCode: 0,
                stdout: JSON.stringify([{
                    hwnd: 9001,
                    processId: 4242,
                    processName: 'evb-viewer',
                    title: 'EVB Viewer',
                    width: 1280,
                    height: 800,
                    ownerHwnd: 0,
                    className: 'Chrome_WidgetWin_1',
                    isForeground: true,
                }]),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    matchCount: 1,
                    hasMore: false,
                    matches: [{
                        selector: 'btn-other-c3d4',
                        type: 'Button',
                        name: 'Other',
                        automationId: 'otherButton',
                    }],
                }),
                stderr: '',
            },
            {
                exitCode: 0,
                stdout: JSON.stringify({
                    filePath: 'C:\\evidence\\viewer.png',
                    width: 1280,
                    height: 800,
                    processId: 4242,
                    windowTitle: 'EVB Viewer',
                    hwnd: 9001,
                }),
                stderr: '',
            },
        ]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.findWindow({ processId: 4242 })).resolves.toMatchObject({handle: '9001'});
        await adapter.findControl(element({
            handle: '9002',
            controlType: 'Window',
            processId: null,
        }), {
            controlType: 'Button',
            automationId: 'otherButton',
        });
        await adapter.screenshot('C:\\evidence\\viewer.png');
        expect(scripted.calls[2]?.args).toEqual([
            'ui',
            'screenshot',
            '--json',
            '--output',
            'C:\\evidence\\viewer.png',
            '--window',
            '9001',
        ]);
    });

    it('reports unsupported state when an operation has no usable target', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify({
                elementId: 'x',
                pattern: 'Invoke',
                hwnd: 9001,
            }),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await expect(adapter.screenshot('C:\\evidence\\screen.png'))
            .rejects.toBeInstanceOf(UnsupportedWinappOperationError);
    });
});

describe('UIA3 PowerShell adapter', () => {
    it('parses the element payload the query script prints', () => {
        expect(parseUia3Elements('[{"runtimeId":"42.1","controlType":"Edit","name":"File name:","automationId":null,"processId":7}]'))
            .toEqual([{
                handle: '42.1',
                controlType: 'Edit',
                name: 'File name:',
                automationId: null,
                processId: 7,
            }]);
        expect(parseUia3Elements('')).toEqual([]);
        expect(() => parseUia3Elements('<html>')).toThrow('not JSON');
        expect(() => parseUia3Elements('[{"runtimeId":"1"}]')).toThrow('unrecognized element payload');
    });

    it('passes query fields as named script parameters', async () => {
        const scripted = scriptedPowerShell([{
            exitCode: 0,
            stdout: '[{"runtimeId":"9.1","controlType":"Window","name":"Save As","automationId":null,"processId":4242}]',
            stderr: '',
        }]);
        const adapter = createUia3PowerShellAdapter({
            powerShell: scripted.powerShell,
            clock: testClock,
        });
        const window = await adapter.findWindow({
            titleContains: 'Save As',
            processId: 4242,
        });
        expect(window?.handle).toBe('9.1');
        expect(scripted.calls[0]).toEqual({
            scriptName: 'uia-query.ps1',
            args: [
                '-Kind',
                'window',
                '-TitleContains',
                'Save As',
                '-ProcessId',
                '4242',
            ],
        });
        expect(adapter.driver).toBe('uia3');
    });

    it('sends an action by runtime id and records it', async () => {
        const scripted = scriptedPowerShell([{
            exitCode: 0,
            stdout: '{"completed":true}',
            stderr: '',
        }]);
        const adapter = createUia3PowerShellAdapter({
            powerShell: scripted.powerShell,
            clock: testClock,
        });
        await adapter.setValue(element({ controlType: 'Edit' }), 'C:\\out\\файл.pdf');
        expect(scripted.calls[0]?.args).toEqual([
            '-Action',
            'set-value',
            '-RuntimeId',
            '42.1',
            '-Value',
            'C:\\out\\файл.pdf',
        ]);
        expect(adapter.actionLog.entries()).toHaveLength(1);
    });

    it('maps a locked desktop reported by the script to the typed error', async () => {
        const scripted = scriptedPowerShell([{
            exitCode: 3,
            stdout: '',
            stderr: 'the input desktop is not available to this session',
        }]);
        const adapter = createUia3PowerShellAdapter({
            powerShell: scripted.powerShell,
            clock: testClock,
        });
        await expect(adapter.findWindow({ titleContains: 'Print' }))
            .rejects.toBeInstanceOf(DesktopUnavailableError);
    });
});
