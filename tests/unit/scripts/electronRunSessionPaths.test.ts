import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getCurrentSessionName,
    releaseCurrentSessionName,
    sessionDir,
    setCurrentSessionName,
    validateSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

describe('electron run session paths', () => {
    it('allows simple session names', () => {
        expect(validateSessionName('default')).toBe('default');
        expect(validateSessionName('smoke-test_1.local')).toBe('smoke-test_1.local');
    });

    it('rejects session names that can escape the sessions directory', () => {
        for (const name of [
            '',
            '.',
            '..',
            '../default',
            'default/other',
            'default\\other',
            '/tmp/default',
        ]) {
            expect(() => validateSessionName(name)).toThrow(/Session name/u);
            expect(() => sessionDir(name)).toThrow(/Session name/u);
        }
    });

    it('validates the current session before storing it', () => {
        expect(() => setCurrentSessionName('../default')).toThrow(/Session name/u);
    });

    it('releases only the session that still owns the process scope', () => {
        setCurrentSessionName('retiring-session');
        expect(releaseCurrentSessionName('retiring-session')).toBe(true);
        expect(getCurrentSessionName()).toBe('default');

        setCurrentSessionName('replacement-session');
        expect(releaseCurrentSessionName('retiring-session')).toBe(false);
        expect(getCurrentSessionName()).toBe('replacement-session');
        setCurrentSessionName('default');
    });
});
