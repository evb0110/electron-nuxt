import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ILandingVendorModule { transformVendoredSource: (source: string) => string }

const { transformVendoredSource } = await import(
    pathToFileURL(resolve(process.cwd(), 'landing/scripts/vendor.mjs')).href
) as ILandingVendorModule;

describe('landing vendor sync', () => {
    it('rewrites package imports for the self-contained landing app', () => {
        expect(transformVendoredSource([
            'import { format } from "@evb/i18n-core/messageFormat";',
            'import { selectRelease } from "@evb/releaseSelection/releaseSelection";',
        ].join('\n'))).toBe([
            'import { format } from "./messageFormat";',
            'import { selectRelease } from "./releaseSelection";',
        ].join('\n'));
    });
});
