import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PACKAGED_STARTUP_READY_MARKER,
    isAllowedPackagedToolExitCode,
    isPackagedStartupReady,
    parseAllowedToolExitCodes,
} from '../../../scripts/releaseVerificationHelpers';

describe('release verification helpers', () => {
    it('exposes a stable packaged-startup ready marker token', () => {
        expect(PACKAGED_STARTUP_READY_MARKER).toBe('[packaged-startup-ready]');
    });

    it('requires both a ready renderer and live process for packaged startup readiness', () => {
        expect(isPackagedStartupReady({
            appAlive: true,
            rendererReady: true,
        })).toBe(true);

        expect(isPackagedStartupReady({
            appAlive: true,
            rendererReady: false,
        })).toBe(false);

        expect(isPackagedStartupReady({
            appAlive: false,
            rendererReady: true,
        })).toBe(false);
    });

    it('parses allowed packaged-tool exit codes without dropping non-zero codes', () => {
        expect(parseAllowedToolExitCodes('0,1,10')).toEqual(new Set([
            0,
            1,
            10,
        ]));
        expect(isAllowedPackagedToolExitCode(10, '0,1,10')).toBe(true);
        expect(isAllowedPackagedToolExitCode(1, '0,1,10')).toBe(true);
        expect(isAllowedPackagedToolExitCode(2, '0,1,10')).toBe(false);
    });
});
