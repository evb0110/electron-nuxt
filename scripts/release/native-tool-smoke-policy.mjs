const MAC_PACKAGED_TOOL_SMOKE_POLICY = {
    'evb-pdf-image-combine': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-image-combine'],
    },
    'evb-pdf-image-combine-protocol': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['3'],
    },
    'evb-pdf-image-combine-compact-manifest': {
        allowedExitCodes: new Set([1]),
        expectedOutputTokens: ['missing --compact-manifest value'],
    },
    'evb-pdf-page-ops': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-page-ops'],
    },
    'evb-pdf-search': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-search'],
    },
    ddjvu: {
        allowedExitCodes: new Set([
            0,
            1,
            10,
        ]),
        expectedOutputTokens: [
            'ddjvu',
            'djvu',
        ],
    },
    djvused: {
        allowedExitCodes: new Set([
            0,
            10,
        ]),
        expectedOutputTokens: [
            'djvused',
            'djvu',
        ],
    },
    djvudump: {
        allowedExitCodes: new Set([
            0,
            1,
            10,
        ]),
        expectedOutputTokens: [
            'djvudump',
            'djvu',
        ],
    },
    pdfinfo: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdfinfo',
            'poppler',
        ],
    },
    pdftoppm: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdftoppm',
            'poppler',
        ],
    },
    pdftotext: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdftotext',
            'poppler',
        ],
    },
    qpdf: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['qpdf'],
    },
    tesseract: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['tesseract'],
    },
    unpaper: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['unpaper'],
    },
};

export function getMacPackagedToolSmokePolicy(toolName) {
    const policy = MAC_PACKAGED_TOOL_SMOKE_POLICY[toolName];
    if (!policy) {
        throw new Error(`Unsupported packaged tool smoke policy "${toolName}"`);
    }

    return policy;
}

export function assertMacPackagedToolSmoke(toolName, exitCode, output) {
    const policy = getMacPackagedToolSmokePolicy(toolName);
    if (!policy.allowedExitCodes.has(exitCode)) {
        throw new Error(
            `Packaged tool smoke test failed (${toolName}) with exit code ${exitCode}`,
        );
    }

    const normalizedOutput = output.trim().toLowerCase();
    if (!normalizedOutput) {
        throw new Error(`Packaged tool smoke test produced no output for ${toolName}`);
    }

    if (!policy.expectedOutputTokens.some(token => normalizedOutput.includes(token))) {
        throw new Error(
            `Packaged tool smoke test output for ${toolName} did not match any expected signature`,
        );
    }
}
