import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    guestLayoutForRoot,
    guestRunPaths,
    isPathInsideGuestRoot,
    joinGuestPath,
    readyMarkerRunId,
    WINDOWS_GUEST_PATH_SEPARATOR,
} from '@scripts/windows-test/guest/guestPaths';

const runId = '20260904T120000Z-0123456789ab';

describe('guest path layout', () => {
    it('derives every mailbox location from the guest root', () => {
        const layout = guestLayoutForRoot('C:\\evb-test');
        expect(layout.separator).toBe(WINDOWS_GUEST_PATH_SEPARATOR);
        expect(layout.inboxDir).toBe('C:\\evb-test\\inbox');
        expect(layout.markerFile).toBe('C:\\evb-test\\state\\test-marker.json');
        expect(layout.heartbeatFile).toBe('C:\\evb-test\\state\\heartbeat.json');
    });

    it('places run files under the run id so two runs cannot collide', () => {
        const paths = guestRunPaths(guestLayoutForRoot('C:\\evb-test'), runId);
        expect(paths.jobFile).toBe(`C:\\evb-test\\inbox\\${runId}.job.json`);
        expect(paths.readyMarkerFile).toBe(`C:\\evb-test\\inbox\\${runId}.ready`);
        expect(paths.cancelFile).toBe(`C:\\evb-test\\inbox\\${runId}.cancel`);
        expect(paths.resultTempFile).toBe(`${paths.resultFile}.tmp`);
        expect(paths.fixtureManifestFile).toBe(`C:\\evb-test\\staging\\${runId}\\fixtures\\manifest.json`);
    });

    it('reads the run id back from a ready marker name only', () => {
        expect(readyMarkerRunId(`${runId}.ready`)).toBe(runId);
        expect(readyMarkerRunId(`${runId}.job.json`)).toBeNull();
        expect(readyMarkerRunId('ready')).toBeNull();
    });

    it('refuses paths that escape the guest root', () => {
        const layout = guestLayoutForRoot('C:\\evb-test');
        expect(isPathInsideGuestRoot(layout, 'C:\\evb-test\\work\\run')).toBe(true);
        expect(isPathInsideGuestRoot(layout, 'C:/evb-test/work/run')).toBe(true);
        expect(isPathInsideGuestRoot(layout, 'C:\\evb-test\\..\\windows')).toBe(false);
        expect(isPathInsideGuestRoot(layout, 'C:\\evb-test-other\\work')).toBe(false);
        expect(isPathInsideGuestRoot(layout, '')).toBe(false);
    });

    it('drops empty segments when joining', () => {
        expect(joinGuestPath('\\', 'C:\\evb-test', '', 'inbox')).toBe('C:\\evb-test\\inbox');
        expect(joinGuestPath('/', '/tmp/root', 'state')).toBe('/tmp/root/state');
    });
});
