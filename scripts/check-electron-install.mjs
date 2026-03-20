import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function main() {
    let electronBinaryPath;

    try {
        electronBinaryPath = require('electron');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            'Electron binary is not installed for this checkout. '
            + 'Fresh installs must allow the electron postinstall script. '
            + `Original error: ${message}`,
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
}
