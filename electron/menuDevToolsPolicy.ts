export const PACKAGED_DEVTOOLS_DIAGNOSTICS_ENV = 'EVB_ENABLE_PACKAGED_DEVTOOLS';

export function shouldExposeDevToolsMenu(
    isDev: boolean,
    diagnosticsFlag = process.env[PACKAGED_DEVTOOLS_DIAGNOSTICS_ENV],
) {
    return isDev || diagnosticsFlag === '1';
}
