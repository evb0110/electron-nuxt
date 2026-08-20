import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class FakeScriptElement extends EventTarget {
    public readonly dataset: Record<string, string> = {};
    public src = '';
    public async = false;
    public isConnected = false;

    public constructor(private readonly removeSelf: (script: FakeScriptElement) => void) {
        super();
    }

    public remove() {
        this.isConnected = false;
        this.removeSelf(this);
    }
}

function installDocumentDouble() {
    const scripts: FakeScriptElement[] = [];
    const remove = (script: FakeScriptElement) => {
        const index = scripts.indexOf(script);
        if (index >= 0) {
            scripts.splice(index, 1);
        }
    };
    vi.stubGlobal('document', {
        querySelector: () => scripts[0] ?? null,
        createElement: () => new FakeScriptElement(remove),
        head: {append(script: FakeScriptElement) {
            script.isConnected = true;
            scripts.push(script);
        }},
    });
    vi.stubGlobal('window', {});
    return scripts;
}

describe('loadDjvuJs', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shares one script load across concurrent callers', async () => {
        const scripts = installDocumentDouble();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const secondLoad = loadDjvuJs();
        expect(scripts).toHaveLength(1);

        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));

        await expect(Promise.all([
            firstLoad,
            secondLoad,
        ])).resolves.toEqual([
            djvuGlobal,
            djvuGlobal,
        ]);
        expect(scripts).toHaveLength(1);
        expect(scripts[0]?.dataset.djvujsState).toBe('ready');
    });

    it('removes a failed script and allows a clean retry', async () => {
        const scripts = installDocumentDouble();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        scripts[0]?.dispatchEvent(new Event('error'));

        await expect(firstLoad).rejects.toThrow('Failed to load DjVu.js');
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('times out a hung load, removes it, and permits retry', async () => {
        const scripts = installDocumentDouble();
        const {
            DJVU_SCRIPT_LOAD_TIMEOUT_MS,
            loadDjvuJs,
        } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const rejection = expect(firstLoad).rejects.toThrow('Timed out loading DjVu.js');
        await vi.advanceTimersByTimeAsync(DJVU_SCRIPT_LOAD_TIMEOUT_MS);
        await rejection;
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('rejects and removes a script that loads without exposing the API', async () => {
        const scripts = installDocumentDouble();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const load = loadDjvuJs();
        scripts[0]?.dispatchEvent(new Event('load'));

        await expect(load).rejects.toThrow('without exposing window.DjVu');
        expect(scripts).toHaveLength(0);
    });
});
