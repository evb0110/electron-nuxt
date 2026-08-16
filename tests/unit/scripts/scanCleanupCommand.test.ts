import {
    describe,
    expect,
    it,
} from 'vitest';
import {runDiagnosticCommand} from '@scripts/diagnostics/scan-cleanup-command.mjs';

describe('scan-cleanup diagnostic command runner', () => {
    it('waits for inherited child streams before resolving', async () => {
        const inheritedChildScript = [
            'setTimeout(() => {',
            '    process.stdout.write(\'late stdout\\n\');',
            '    process.stderr.write(\'late stderr\\n\');',
            '}, 100);',
        ].join('\n');
        const parentScript = [
            'const {spawn} = require(\'node:child_process\');',
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(inheritedChildScript)}], {stdio: 'inherit'});`,
            'child.unref();',
        ].join('\n');

        await expect(runDiagnosticCommand(process.execPath, [
            '-e',
            parentScript,
        ])).resolves.toMatchObject({
            code: 0,
            stderr: 'late stderr\n',
            stdout: 'late stdout\n',
        });
    });

    it('bounds the inherited-stream drain when a grandchild never exits', async () => {
        const grandchildScript = 'setInterval(() => {}, 60_000);';
        const parentScript = [
            'const {spawn} = require(\'node:child_process\');',
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {stdio: 'inherit'});`,
            'child.unref();',
        ].join('\n');

        const startedAt = Date.now();
        await expect(runDiagnosticCommand(process.execPath, [
            '-e',
            parentScript,
        ], {stdioDrainTimeoutMs: 50})).resolves.toMatchObject({code: 0});
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
});
