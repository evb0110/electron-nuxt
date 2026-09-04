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
    parseWinappElements,
    parseWinappVersion,
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
    it('parses both the bare array and the wrapped element list', () => {
        expect(parseWinappElements('[{"runtimeId":"42.1","controlType":"Button","name":"Save"}]')).toEqual([{
            handle: '42.1',
            controlType: 'Button',
            name: 'Save',
            automationId: null,
            processId: null,
        }]);
        expect(parseWinappElements('{"elements":[{"runtimeId":"7","controlType":"Edit","name":"File name:","processId":9}]}'))
            .toHaveLength(1);
        expect(parseWinappElements('   ')).toEqual([]);
        expect(() => parseWinappElements('not json')).toThrow('not JSON');
        expect(() => parseWinappElements('{"elements":[{"runtimeId":""}]}')).toThrow('unrecognized element payload');
        expect(() => parseWinappElements('{"elements":{"runtimeId":"1"}}')).toThrow('did not contain an element list');
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

    it('builds a find-elements command from the selector and filters localized names', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: JSON.stringify([
                {
                    runtimeId: '1',
                    controlType: 'Button',
                    name: 'Сохранить',
                },
                {
                    runtimeId: '2',
                    controlType: 'Button',
                    name: 'Cancel',
                },
            ]),
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        const found = await adapter.findControl(element({ controlType: 'Window' }), {
            controlType: 'Button',
            automationId: 'saveButton',
            processId: 4242,
            name: {
                exact: 'Save',
                localizedFallbacks: ['Сохранить'],
            },
        });
        expect(found.map(candidate => candidate.handle)).toEqual(['1']);
        expect(scripted.calls[0]?.args).toEqual([
            'uia',
            'find-elements',
            '--window',
            '42.1',
            '--json',
            '--control-type',
            'Button',
            '--automation-id',
            'saveButton',
            '--process-id',
            '4242',
        ]);
    });

    it('records every action it performs for the evidence trail', async () => {
        const scripted = scriptedExec([{
            exitCode: 0,
            stdout: '[]',
            stderr: '',
        }]);
        const adapter = createWinappCliAdapter({
            exec: scripted.exec,
            clock: testClock,
        });
        await adapter.invoke(element());
        await adapter.setValue(element({ controlType: 'Edit' }), 'C:\\out\\файл.pdf');
        await adapter.sendKeys(element({ controlType: 'Window' }), '^s');
        expect(adapter.actionLog.entries()).toEqual([
            {
                actionKind: 'pattern',
                action: 'invoke',
                target: '42.1',
            },
            {
                actionKind: 'pattern',
                action: 'set-value',
                target: '42.1',
            },
            {
                actionKind: 'input',
                action: 'send-keys',
                target: '42.1',
            },
        ]);
        expect(adapter.driver).toBe('winapp');
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
        expect(scripted.calls[0]?.args).toContain('--title-contains');
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
