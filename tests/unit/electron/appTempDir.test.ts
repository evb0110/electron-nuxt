import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const paths: Record<string, string> = {
        temp: '/tmp',
        userData: '/profiles/default',
    };
    return {paths};
});

vi.mock('electron', () => ({app: {getPath: (name: string) => mocks.paths[name]}}));

const {
    createAppTempNamespace,
    getAppTempDirPath,
    initializeAppTempNamespace,
} = await import('@electron/utils/appTempDir');

describe('app temp directory namespace', () => {
    afterEach(() => {
        delete process.env.EVB_APP_TEMP_NAMESPACE;
    });

    it('derives a stable opaque namespace per userData profile', () => {
        const first = createAppTempNamespace('/profiles/first');

        expect(first).toBe(createAppTempNamespace('/profiles/first'));
        expect(first).not.toBe(createAppTempNamespace('/profiles/second'));
        expect(first).not.toContain('profiles');
    });

    it('propagates the profile namespace for worker-safe temp resolution', () => {
        const namespace = initializeAppTempNamespace('/profiles/automation-a');

        expect(process.env.EVB_APP_TEMP_NAMESPACE).toBe(namespace);
        expect(getAppTempDirPath()).toBe(`/tmp/evb-viewer-${namespace}`);
    });
});
