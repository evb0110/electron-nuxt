import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
export const NATIVE_PAGE_OPS_TEST_ENABLE_ENV = 'EVB_PDF_PAGE_OPS_ENABLE';

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-page-ops.exe'
        : 'evb-pdf-page-ops';
}

export function isNativePageOpsDisabled() {
    return process.env.EVB_PDF_PAGE_OPS_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env[NATIVE_PAGE_OPS_TEST_ENABLE_ENV] !== '1');
}

export function resolveNativePageOpsPath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-page-ops',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_PAGE_OPS_PATH,
        isPackaged,
    });
}
