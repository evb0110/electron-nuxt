import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getCliErrorMessage } from './release/cli-error.mjs';

const require = createRequire(import.meta.url);

function main() {
    let electronBinaryPath;

    try {
        electronBinaryPath = require('electron');
    } catch (error) {
        throw new Error(
            'Electron binary is not installed for this checkout. '
            + 'Fresh installs must allow the electron postinstall script. '
            + `Original error: ${getCliErrorMessage(error)}`,
        );
    }

    if (typeof electronBinaryPath !== 'string' || electronBinaryPath.length === 0) {
        throw new Error('Electron package did not resolve to an executable path');
    }

    if (!existsSync(electronBinaryPath)) {
        throw new Error(`Electron executable does not exist at ${electronBinaryPath}`);
    }

    process.stdout.write(`Electron install verified: ${electronBinaryPath}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${getCliErrorMessage(error)}\n`);
    process.exit(1);
}
