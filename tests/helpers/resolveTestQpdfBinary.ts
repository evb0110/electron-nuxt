import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

export function resolveTestQpdfBinary(env: NodeJS.ProcessEnv = process.env) {
    return env.EVB_QPDF_PATH
        ?? env.QPDF_BINARY
        ?? getPdfNativeToolPaths().qpdf;
}
