import {
    describe,
    expect,
    it,
} from 'vitest';
import {parseExecutableArgument} from '@scripts/release/verifyPackagedDiagnosticsSmoke';

describe('packaged diagnostics smoke arguments', () => {
    it('reads only the value following the executable flag', () => {
        expect(parseExecutableArgument(['--allow-rejected'])).toBeNull();
        expect(parseExecutableArgument([
            '--executable',
            '/tmp/EVB Viewer',
        ])).toBe('/tmp/EVB Viewer');
        expect(parseExecutableArgument(['--executable'])).toBeNull();
    });
});
