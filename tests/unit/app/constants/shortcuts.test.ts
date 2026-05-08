import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getShortcutLabels,
    isMacPlatformHint,
} from '@app/constants/shortcuts';

describe('shortcuts', () => {
    it('recognizes common macOS platform hints', () => {
        expect(isMacPlatformHint('MacIntel')).toBe(true);
        expect(isMacPlatformHint('"macOS"')).toBe(true);
        expect(isMacPlatformHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
        expect(isMacPlatformHint('Win32')).toBe(false);
    });

    it('formats modifier labels for explicit platforms', () => {
        expect(getShortcutLabels(true).openFile).toBe('Cmd+O');
        expect(getShortcutLabels(false).openFile).toBe('Ctrl+O');
    });
});
