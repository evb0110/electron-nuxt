import {execFileSync} from 'node:child_process';
import {
    chmodSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {assertElectronNativePageOps} from '@scripts/assert-electron-native-page-ops.mjs';

const scriptPath = fileURLToPath(new URL('../../../scripts/assert-electron-native-page-ops.mjs', import.meta.url));

describe('Electron native page-ops admission', () => {
    it('requires the launcher flag for native suites', () => {
        expect(() => assertElectronNativePageOps({
            project: 'e2e-regression',
            env: {},
        })).toThrow('EVB_PDF_PAGE_OPS_ENABLE=1');
    });

    it('keeps explicit native-disabled negative runs admissible', () => {
        expect(assertElectronNativePageOps({
            project: 'e2e-regression',
            env: {EVB_PDF_PAGE_OPS_DISABLE: '1'},
        })).toMatchObject({
            required: true,
            disabled: true,
            toolPath: null,
        });
    });

    it('does not require page ops for non-native suites', () => {
        expect(assertElectronNativePageOps({
            project: 'e2e-rapid-navigation',
            env: {},
        })).toMatchObject({
            required: false,
            disabled: false,
            toolPath: null,
        });
    });

    it('admits a runnable native binary', () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-native-page-ops-admission-'));
        const binaryPath = join(directory, process.platform === 'win32' ? 'evb-pdf-page-ops.cmd' : 'evb-pdf-page-ops');
        try {
            writeFileSync(binaryPath, process.platform === 'win32'
                ? '@echo evb-pdf-page-ops test fixture\r\n'
                : '#!/bin/sh\nprintf "evb-pdf-page-ops test fixture\\n"\n');
            if (process.platform !== 'win32') {
                chmodSync(binaryPath, 0o755);
            }
            const output = execFileSync(process.execPath, [
                scriptPath,
                'e2e-regression',
            ], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    EVB_PDF_PAGE_OPS_ENABLE: '1',
                    EVB_PDF_PAGE_OPS_DISABLE: '',
                    EVB_PDF_PAGE_OPS_PATH: binaryPath,
                },
                encoding: 'utf8',
            });
            expect(output).toContain('[native-page-ops] admitted e2e-regression:');
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
