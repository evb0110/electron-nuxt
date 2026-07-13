import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canonicalBundledApplicationVersion,
    resolveApplicationVersion,
} from '@electron/appVersion';

describe('application version truth', () => {
    it('uses signed bundle metadata in packaged builds', () => {
        expect(resolveApplicationVersion({
            isPackaged: true,
            getVersion: () => '0.1.999',
        })).toBe('0.1.999');
    });

    it('uses the bundled repository version in generic Electron development runs', () => {
        expect(canonicalBundledApplicationVersion).toMatch(/^0\.1\.\d+$/u);
        expect(resolveApplicationVersion({
            isPackaged: false,
            getVersion: () => '42.3.3',
        })).toBe(canonicalBundledApplicationVersion);
    });
});
