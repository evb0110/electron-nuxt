import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import { shouldRemoveSessionStopArtifacts } from '@scripts/electron-run/stopSession';

const projectRoot = process.cwd();

function readProjectSource(path: string) {
    return readFileSync(join(projectRoot, path), 'utf8');
}

describe('Electron automation graceful shutdown policy', () => {
    it('exposes a controller-owned shutdown command', () => {
        expect(isElectronRunCommand('shutdown')).toBe(true);
        expect(parseElectronRunCommandRequest({
            command: 'shutdown',
            args: [],
        })).toEqual({
            command: 'shutdown',
            args: [],
        });
    });

    it('closes Electron through the automation browser before process-tree fallback', () => {
        const sessionSource = readProjectSource('scripts/electron-run/sessionManager.ts');
        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const gracefulCloseIndex = sessionSource.indexOf('state.browser.close()');
        const electronFallbackIndex = sessionSource.indexOf('killProcessTree(electronPid');
        const shutdownCommandIndex = stopSource.indexOf('info, \'shutdown\'');
        const controllerFallbackIndex = stopSource.indexOf('killVerifiedSessionProcess', shutdownCommandIndex);

        expect(gracefulCloseIndex).toBeGreaterThan(-1);
        expect(electronFallbackIndex).toBeGreaterThan(gracefulCloseIndex);
        expect(shutdownCommandIndex).toBeGreaterThan(-1);
        expect(controllerFallbackIndex).toBeGreaterThan(shutdownCommandIndex);
        expect(sessionSource).toContain('Graceful app shutdown complete');
        expect(sessionSource).toContain('Graceful shutdown timed out; using process-tree fallback');
    });

    it('keeps the E2E browser attached until the controller initiates app shutdown', () => {
        const source = readProjectSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');
        const stopBody = source.slice(
            source.indexOf('const stop = async () => {'),
            source.indexOf('return {', source.indexOf('const stop = async () => {')),
        );

        expect(stopBody).toContain('stopSingleSession(scopedSessionName)');
        expect(stopBody).not.toContain('browser.disconnect()');
    });

    it('retains session artifacts whenever any verified termination is refused', () => {
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            true,
        ])).toBe(true);
        expect(shouldRemoveSessionStopArtifacts([
            false,
            true,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            false,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            false,
        ])).toBe(false);

        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const refusalBranch = stopSource.slice(
            stopSource.indexOf('if (!shouldRemoveSessionStopArtifacts(outcomes))'),
            stopSource.indexOf('removeSessionStopFiles(name);'),
        );
        expect(refusalBranch).toContain('retainSessionStopArtifacts(name, info)');
        expect(refusalBranch).toContain('throw new Error');
    });
});
