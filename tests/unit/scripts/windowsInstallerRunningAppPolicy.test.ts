import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('Windows installer running-app policy', () => {
    it('never terminates a running EVB Viewer process during replacement', async () => {
        const installer = await readFile('build/installer.nsh', 'utf8');

        expect(installer).toContain('!macro customCheckAppRunning');
        expect(installer).toContain('${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}"');
        expect(installer).toContain('MB_RETRYCANCEL|MB_ICONEXCLAMATION');
        expect(installer).toContain('installer will not force-close the app');
        expect(installer).not.toContain('${GetProcessInfo}');
        expect(installer).not.toMatch(/\$pid\b/u);
        expect(installer).not.toMatch(/Stop-Process|taskkill|KILL_PROCESS/u);
    });

    it('waits for coordinated shutdown during an in-app update and then fails closed', async () => {
        const installer = await readFile('build/installer.nsh', 'utf8');

        expect(installer).toContain('${if} ${isUpdated}');
        expect(installer).toContain('IntCmp $R1 30');
        expect(installer).toContain('The update was not installed.');
    });
});
