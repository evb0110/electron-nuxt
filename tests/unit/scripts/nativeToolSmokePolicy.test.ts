import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    assertMacPackagedToolSmoke,
    getMacPackagedToolSmokePolicy,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href);

describe('native tool smoke policy', () => {
    it('keeps mac packaged tool smoke expectations explicit per tool', () => {
        expect(getMacPackagedToolSmokePolicy('ddjvu').allowedExitCodes).toEqual(new Set([
            0,
            1,
            10,
        ]));
        expect(getMacPackagedToolSmokePolicy('djvused').allowedExitCodes).toEqual(new Set([
            0,
            10,
        ]));
        expect(getMacPackagedToolSmokePolicy('unpaper').allowedExitCodes).toEqual(new Set([0]));
    });

    it('requires both an allowed exit code and recognizable output', () => {
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'qpdf version 12.0.0')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('ddjvu', 1, 'ddjvu usage')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('unpaper', 0, 'Usage: unpaper [options]')).not.toThrow();
        expect(() => assertMacPackagedToolSmoke('qpdf', 2, 'qpdf version 12.0.0')).toThrow(
            'Packaged tool smoke test failed (qpdf) with exit code 2',
        );
        expect(() => assertMacPackagedToolSmoke('qpdf', 0, 'unexpected output')).toThrow(
            'Packaged tool smoke test output for qpdf did not match any expected signature',
        );
    });
});
