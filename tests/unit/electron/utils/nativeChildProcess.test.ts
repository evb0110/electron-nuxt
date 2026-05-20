import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDetachedChildProcessSpawnOptions,
    shouldUseDetachedProcessGroup,
} from '@electron/utils/nativeChildProcess';

describe('nativeChildProcess', () => {
    it('uses detached process groups on non-Windows platforms', () => {
        expect(shouldUseDetachedProcessGroup('darwin')).toBe(true);
        expect(shouldUseDetachedProcessGroup('linux')).toBe(true);
        expect(shouldUseDetachedProcessGroup('win32')).toBe(false);
    });

    it('preserves caller spawn options while applying detached policy', () => {
        expect(createDetachedChildProcessSpawnOptions({
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        }, 'darwin')).toMatchObject({
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            detached: true,
        });

        expect(createDetachedChildProcessSpawnOptions({
            shell: false,
            stdio: 'pipe',
        }, 'win32')).toMatchObject({
            shell: false,
            stdio: 'pipe',
            detached: false,
        });
    });
});
