import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createGuestPowerShellRunner,
    guestPowerShellArguments,
    guestPowerShellScriptNames,
    GuestPowerShellScriptError,
    POWERSHELL_BASE_ARGUMENTS,
    POWERSHELL_EXECUTABLE,
    type TGuestPowerShellScriptName,
} from '@scripts/windows-test/guest/guestPowerShell';
import type {
    IGuestCommandResult,
    IGuestCommandRunner,
} from '@scripts/windows-test/guest/guestRuntime';

const scriptsDirectory = path.join(process.cwd(), 'scripts', 'windows-test', 'guest', 'powershell');

function fakeExec(result: IGuestCommandResult) {
    const calls: Array<{
        command: string;
        args: readonly string[];
    }> = [];
    const exec: IGuestCommandRunner = { run: (command, args) => {
        calls.push({
            command,
            args,
        });
        return Promise.resolve(result);
    } };
    return {
        calls,
        exec,
    };
}

function runner(result: IGuestCommandResult) {
    const fake = fakeExec(result);
    return {
        calls: fake.calls,
        powerShell: createGuestPowerShellRunner({
            exec: fake.exec,
            scriptsDirectory: 'C:\\evb-test\\worker\\powershell',
            separator: '\\',
        }),
    };
}

describe('guest PowerShell runner', () => {
    it('invokes script files with the hardened argument list', () => {
        expect(POWERSHELL_EXECUTABLE).toBe('powershell.exe');
        expect(guestPowerShellArguments('C:\\scripts\\probe-identity.ps1', ['C:\\App\\EVB Viewer.exe'])).toEqual([
            ...POWERSHELL_BASE_ARGUMENTS,
            'C:\\scripts\\probe-identity.ps1',
            'C:\\App\\EVB Viewer.exe',
        ]);
    });

    it('passes arguments as separate argv entries so nothing is interpolated into PowerShell source', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '{"jobId":1}',
            stderr: '',
        });
        await harness.powerShell.run('hold-file-handle.ps1', [
            '-Path',
            'C:\\evb-test\\work\\run\\inputs\\doc"; Remove-Item C:\\ -Recurse; #.pdf',
        ]);
        const call = harness.calls[0];
        expect(call?.command).toBe('powershell.exe');
        expect(call?.args).toEqual([
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'C:\\evb-test\\worker\\powershell\\hold-file-handle.ps1',
            '-Path',
            'C:\\evb-test\\work\\run\\inputs\\doc"; Remove-Item C:\\ -Recurse; #.pdf',
        ]);
    });

    it('refuses a script name that is not on the allow list', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });
        await expect(harness.powerShell.run('rm-rf.ps1' as TGuestPowerShellScriptName))
            .rejects.toThrow('Unknown guest PowerShell script');
        expect(harness.calls).toHaveLength(0);
    });

    it('turns a failing script into a typed error instead of parsing its output', async () => {
        const harness = runner({
            exitCode: 3,
            stdout: '',
            stderr: 'the input desktop is not available to this session',
        });
        await expect(harness.powerShell.runJson('uia-query.ps1')).rejects.toBeInstanceOf(GuestPowerShellScriptError);
    });

    it('parses JSON from a successful script', async () => {
        const harness = runner({
            exitCode: 0,
            stdout: '{"sha256":"abc"}',
            stderr: '',
        });
        expect(await harness.powerShell.runJson('get-file-hash.ps1', [
            '-Path',
            'C:\\file.pdf',
        ])).toEqual({ sha256: 'abc' });
    });
});

describe('guest PowerShell script files', () => {
    let fileNames: string[] = [];
    const sources = new Map<string, string>();

    beforeAll(async () => {
        fileNames = (await readdir(scriptsDirectory)).sort((left, right) => left.localeCompare(right));
        for (const fileName of fileNames) {
            sources.set(fileName, await readFile(path.join(scriptsDirectory, fileName), 'utf8'));
        }
    });

    it('ships exactly the scripts the runner allows', () => {
        expect(fileNames).toEqual([...guestPowerShellScriptNames].sort((left, right) => left.localeCompare(right)));
    });

    it('declares parameters, strict mode and fail-fast error handling in every script', () => {
        for (const [
            fileName,
            source,
        ] of sources) {
            expect(source, fileName).toMatch(/^param\(/mu);
            expect(source, fileName).toContain('Set-StrictMode -Version Latest');
            expect(source, fileName).toContain('$ErrorActionPreference = \'Stop\'');
            expect(source, fileName).toMatch(/^<#/u);
        }
    });

    it('keeps credentials out of the tree', () => {
        for (const [
            fileName,
            source,
        ] of sources) {
            expect(source.toLowerCase(), fileName).not.toContain('convertto-securestring');
            expect(source.toLowerCase(), fileName).not.toMatch(/\$password|-password\b|net user /u);
        }
    });

    it('gives the file-handle helper a bounded lifetime and a readiness handshake', () => {
        const source = sources.get('hold-file-handle.ps1') ?? '';
        expect(source).toContain('[string]$Path');
        expect(source).toContain('[int]$DurationSeconds');
        expect(source).toContain('[string]$ReadyFile');
        expect(source).toContain('ValidateRange(1, 600)');
        expect(source).toContain('[System.IO.FileShare]::None');
    });

    it('documents the logon task as an admin provisioning step with an interactive token', () => {
        const source = sources.get('register-worker-logon-task.ps1') ?? '';
        expect(source).toContain('run once by an administrator');
        expect(source).toContain('-LogonType Interactive');
        expect(source).toContain('-RunLevel Limited');
        expect(source).toContain('New-ScheduledTaskTrigger -AtLogOn');
        expect(source).toContain('no credentials');
    });

    it('reports a missing interactive desktop in words the adapters recognize', () => {
        for (const fileName of [
            'uia-query.ps1',
            'uia-action.ps1',
        ]) {
            expect(sources.get(fileName) ?? '', fileName).toContain('input desktop');
        }
    });

    it('emits JSON arrays even when a query matches nothing', () => {
        for (const fileName of [
            'get-print-jobs.ps1',
            'uia-query.ps1',
        ]) {
            expect(sources.get(fileName) ?? '', fileName).toContain('$json = \'[]\'');
        }
    });
});
