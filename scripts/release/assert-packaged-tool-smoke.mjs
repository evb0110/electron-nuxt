import { readFileSync } from 'node:fs';
import { assertMacPackagedToolSmoke } from './native-tool-smoke-policy.mjs';
import { getCliErrorMessage } from './cli-error.mjs';

function main() {
    const [
        toolName,
        exitCodeRaw,
        outputFile,
    ] = process.argv.slice(2);

    if (!toolName || !exitCodeRaw || !outputFile) {
        throw new Error(
            'Usage: node scripts/release/assert-packaged-tool-smoke.mjs <tool-name> <exit-code> <output-file>',
        );
    }

    const exitCode = Number.parseInt(exitCodeRaw, 10);
    if (!Number.isFinite(exitCode)) {
        throw new Error(`Invalid packaged tool exit code "${exitCodeRaw}"`);
    }

    const output = readFileSync(outputFile, 'utf8');
    assertMacPackagedToolSmoke(toolName, exitCode, output);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${getCliErrorMessage(error)}\n`);
    process.exit(1);
}
