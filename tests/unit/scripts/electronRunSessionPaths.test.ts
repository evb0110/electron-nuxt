import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    sessionDir,
    setCurrentSessionName,
    validateSessionName,
} from '../../../scripts/electron-run/electronRunSessionPaths';

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
});
