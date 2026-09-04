import { isRecord } from '@contracts/runtimeGuards';
import type { IGuestClock } from '@scripts/windows-test/guest/guestRuntime';
import type { IGuestPowerShellRunner } from '@scripts/windows-test/guest/guestPowerShell';
import {
    createNativeUiActionLog,
    DesktopUnavailableError,
    selectorNameCandidates,
    waitForUniqueControl,
    type INativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import { isDesktopUnavailableMessage } from '@scripts/windows-test/guest/native-ui/winappCliAdapter';

export interface IUia3ElementPayload {
    runtimeId: string;
    controlType: string;
    name: string;
    automationId: string | null;
    processId: number | null;
}

export function isUia3ElementPayload(value: unknown): value is IUia3ElementPayload {
    return isRecord(value)
        && typeof value.runtimeId === 'string'
        && value.runtimeId.length > 0
        && typeof value.controlType === 'string'
        && typeof value.name === 'string'
        && (value.automationId === null || typeof value.automationId === 'string')
        && (value.processId === null || typeof value.processId === 'number');
}

export function parseUia3Elements(stdout: string): IUiElementRef[] {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error(`uia-query.ps1 returned output that is not JSON: ${trimmed.slice(0, 200)}`);
    }
    const list: unknown = Array.isArray(parsed) ? parsed : [parsed];
    if (!Array.isArray(list)) {
        throw new Error('uia-query.ps1 did not return an element list');
    }
    return list.map((candidate) => {
        if (!isUia3ElementPayload(candidate)) {
            throw new Error(`uia-query.ps1 returned an unrecognized element payload: ${JSON.stringify(candidate)}`);
        }
        return {
            handle: candidate.runtimeId,
            controlType: candidate.controlType,
            name: candidate.name,
            automationId: candidate.automationId,
            processId: candidate.processId,
        };
    });
}

export interface ICreateUia3PowerShellAdapterOptions {
    powerShell: IGuestPowerShellRunner;
    clock: IGuestClock;
    actionLog?: INativeUiActionLog;
}

export function createUia3PowerShellAdapter({
    powerShell,
    clock,
    actionLog = createNativeUiActionLog(),
}: ICreateUia3PowerShellAdapterOptions): INativeUiAdapter {
    const runScript = async (
        scriptName: 'uia-query.ps1' | 'uia-action.ps1',
        args: readonly string[],
        description: string,
    ) => {
        const result = await powerShell.run(scriptName, args);
        if (result.exitCode === 0) {
            return result;
        }
        const message = `${result.stderr}\n${result.stdout}`;
        if (isDesktopUnavailableMessage(message)) {
            throw new DesktopUnavailableError(`${description} reported ${message.trim().slice(0, 200)}`);
        }
        throw new Error(`${scriptName} ${description} failed with exit ${result.exitCode}: ${message.trim().slice(0, 300)}`);
    };

    const queryArgs = (kind: string, entries: Array<[string, string | undefined]>) => {
        const args = [
            '-Kind',
            kind,
        ];
        for (const [
            name,
            value,
        ] of entries) {
            if (value !== undefined && value.length > 0) {
                args.push(name, value);
            }
        }
        return args;
    };

    const findControl = async (windowRef: IUiElementRef, selector: IUiSelector) => {
        const result = await runScript('uia-query.ps1', queryArgs('control', [
            [
                '-Root',
                windowRef.handle,
            ],
            [
                '-ControlType',
                selector.controlType,
            ],
            [
                '-AutomationId',
                selector.automationId,
            ],
            [
                '-ProcessId',
                selector.processId === undefined ? undefined : String(selector.processId),
            ],
        ]), 'control query');
        const names = selectorNameCandidates(selector);
        return parseUia3Elements(result.stdout)
            .filter(element => names.length === 0 || names.includes(element.name));
    };

    const desktopRef: IUiElementRef = {
        handle: 'root',
        controlType: 'Pane',
        name: 'Desktop',
        automationId: null,
        processId: null,
    };

    const action = async (
        args: readonly string[],
        description: string,
        actionKind: 'pattern' | 'input',
        target: string,
    ) => {
        await runScript('uia-action.ps1', args, description);
        actionLog.record({
            actionKind,
            action: description,
            target,
        });
    };

    const adapter: INativeUiAdapter = {
        driver: 'uia3',
        actionLog,
        findWindow: async (query: IUiWindowQuery) => {
            const result = await runScript('uia-query.ps1', queryArgs('window', [
                [
                    '-TitleContains',
                    query.titleContains,
                ],
                [
                    '-ClassName',
                    query.className,
                ],
                [
                    '-AutomationId',
                    query.automationId,
                ],
                [
                    '-ProcessId',
                    query.processId === undefined ? undefined : String(query.processId),
                ],
            ]), 'window query');
            return parseUia3Elements(result.stdout)[0] ?? null;
        },
        findControl,
        invoke: ref => action([
            '-Action',
            'invoke',
            '-RuntimeId',
            ref.handle,
        ], 'invoke', 'pattern', ref.handle),
        setValue: (ref, text) => action([
            '-Action',
            'set-value',
            '-RuntimeId',
            ref.handle,
            '-Value',
            text,
        ], 'set-value', 'pattern', ref.handle),
        select: (ref, item) => action([
            '-Action',
            'select',
            '-RuntimeId',
            ref.handle,
            '-Value',
            item,
        ], 'select', 'pattern', ref.handle),
        sendKeys: (windowRef, keys) => action([
            '-Action',
            'send-keys',
            '-RuntimeId',
            windowRef.handle,
            '-Value',
            keys,
        ], 'send-keys', 'input', windowRef.handle),
        waitFor: (selector, timeoutMs) => waitForUniqueControl({
            adapter,
            windowRef: desktopRef,
            selector,
            timeoutMs,
            sleep: clock.sleep,
            now: clock.now,
        }),
        captureTree: async (windowRef) => {
            const result = await runScript('uia-query.ps1', [
                '-Kind',
                'tree',
                '-Root',
                windowRef.handle,
            ], 'tree capture');
            const parsed: unknown = JSON.parse(result.stdout);
            return parsed;
        },
        screenshot: filePath => action([
            '-Action',
            'screenshot',
            '-OutputPath',
            filePath,
        ], 'screenshot', 'pattern', filePath),
    };
    return adapter;
}
