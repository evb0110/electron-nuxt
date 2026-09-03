import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {readFileSync} from 'node:fs';

interface ITestWindow {
    addEventListener: (name: string, listener: (event: unknown) => void) => void;
    location: {
        href: string;
        reload: ReturnType<typeof vi.fn>
    };
    sessionStorage: {
        getItem: (key: string) => string | null;
        setItem: (key: string, value: string) => void;
    };
}

describe('Vite optimize-deps preload recovery', () => {
    let previousDefaultApp: PropertyDescriptor | undefined;

    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        previousDefaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        if (previousDefaultApp) {
            Object.defineProperty(process, 'defaultApp', previousDefaultApp);
        } else {
            Reflect.deleteProperty(process, 'defaultApp');
        }
    });

    it('keeps a Vite recovery projection at warning level', async () => {
        const listeners = new Map<string, (event: unknown) => void>();
        const storage = new Map<string, string>();
        const windowStub: ITestWindow = {
            addEventListener: (name, listener) => listeners.set(name, listener),
            location: {
                href: 'http://localhost:3000/electron',
                reload: vi.fn(),
            },
            sessionStorage: {
                getItem: key => storage.get(key) ?? null,
                setItem: (key, value) => storage.set(key, value),
            },
        };
        vi.stubGlobal('window', windowStub);
        Object.defineProperty(process, 'defaultApp', {
            configurable: true,
            value: true,
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const {installViteOutdatedOptimizeDepRecovery} = await import(
            '@electron/preload/installViteOutdatedOptimizeDepRecovery'
        );

        installViteOutdatedOptimizeDepRecovery();
        listeners.get('unhandledrejection')?.({reason: new Error('Outdated Optimize Dep')});

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[Dev] Matched optimize-deps unhandled rejection'),
            expect.objectContaining({message: 'Outdated Optimize Dep'}),
        );
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('downgrades preload development-control-flow output before it can reach main error logging', () => {
        const source = readFileSync('electron/preload.ts', 'utf8');

        expect(source).toContain('level === \'error\' ? \'warn\' : level');
        expect(source).not.toContain('console.error(message');
    });
});
