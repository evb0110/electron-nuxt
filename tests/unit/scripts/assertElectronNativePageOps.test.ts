import {execFileSync} from 'node:child_process';
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
        const output = execFileSync(process.execPath, [
            scriptPath,
            'e2e-regression',
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                EVB_PDF_PAGE_OPS_ENABLE: '1',
                EVB_PDF_PAGE_OPS_DISABLE: '',
            },
            encoding: 'utf8',
        });
        expect(output).toContain('[native-page-ops] admitted e2e-regression:');
    });
});
