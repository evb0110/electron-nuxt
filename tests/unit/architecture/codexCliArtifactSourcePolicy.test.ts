import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('Codex CLI artifact source policy', () => {
    it('never pipes a floating network response into a shell', async () => {
        const source = await readFile(join(
            process.cwd(),
            'electron/features/agent/codexCli.ts',
        ), 'utf8');

        expect(source).not.toContain('Invoke-Expression');
        expect(source).not.toContain('| sh');
        expect(source).not.toContain('curl -fsSL');
        expect(source).not.toContain('install.ps1');
        expect(source).not.toContain('install.sh');
    });
});
