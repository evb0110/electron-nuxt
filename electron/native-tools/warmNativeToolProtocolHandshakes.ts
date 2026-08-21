import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_RUST_NATIVE_TOOL_PROTOCOLS } from '@contracts/nativeToolProtocols';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { verifyNativeToolProtocol } from '@electron/native-tools/runNativeToolCommand';

// Tools whose first use is interactive, so the extra `--protocol-version` spawn would be
// paid inside a user-visible operation. Batch tools keep paying it on first use.
const WARMED_CRATE_NAMES = new Set([
    'pdf-page-ops',
    'pdf-search',
]);

const currentDir = dirname(fileURLToPath(import.meta.url));
const isPackaged = currentDir.includes('app.asar');

function getToolEnvOverridePath(crateName: string) {
    return process.env[`EVB_${crateName.toUpperCase().replaceAll('-', '_')}_PATH`];
}

/**
 * Pre-runs the protocol handshake so its result is already cached when a tool is first
 * used for real. Every failure is ignored: `verifyNativeToolProtocol` does not cache
 * failed handshakes, so a real invocation still performs its own verification.
 */
export async function warmNativeToolProtocolHandshakes() {
    const warmedTools = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.filter(
        tool => WARMED_CRATE_NAMES.has(tool.crateName),
    );
    await Promise.all(warmedTools.map(async (tool) => {
        const binaryName = process.platform === 'win32' ? `${tool.binaryName}.exe` : tool.binaryName;
        const toolPath = resolveNativeToolPath({
            binaryName,
            crateName: tool.crateName,
            currentDir,
            envOverridePath: getToolEnvOverridePath(tool.crateName),
            isPackaged,
        });
        if (!toolPath || !existsSync(toolPath)) {
            return;
        }
        await verifyNativeToolProtocol(toolPath).catch(() => undefined);
    }));
}
