import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {
    createServer,
    type Server,
} from 'node:http';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let bundlePath = '';
let recoveryBundlePath = '';
let temporaryDirectory = '';
let origin = '';
let server: Server;

beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-idb-migration-'));
    bundlePath = join(temporaryDirectory, 'browser-document-idb.js');
    recoveryBundlePath = join(temporaryDirectory, 'browser-workspace-recovery.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser/browserDocumentIdb.ts')],
        format: 'iife',
        globalName: 'EvbBrowserDocumentIdb',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser/browserWorkspaceRecoveryStore.ts')],
        format: 'iife',
        globalName: 'EvbBrowserWorkspaceRecovery',
        outfile: recoveryBundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>IndexedDB migration harness</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('IndexedDB migration harness did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

describe('browser document IndexedDB migration in Chromium', () => {
    it('upgrades a v1 database without losing its document records', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
                await new Promise<void>((resolveSeed, rejectSeed) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 1);
                    request.onupgradeneeded = () => {
                        request.result.createObjectStore('documents', {keyPath: 'ref'});
                    };
                    request.onerror = () => rejectSeed(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const transaction = database.transaction('documents', 'readwrite');
                        transaction.objectStore('documents').put({
                            ref: 'legacy-ref',
                            name: 'legacy.pdf',
                        });
                        transaction.onerror = () => rejectSeed(transaction.error);
                        transaction.oncomplete = () => {
                            database.close();
                            resolveSeed();
                        };
                    };
                });
            });
            await page.addScriptTag({path: bundlePath});

            const result = await page.evaluate(async () => {
                const productionModule = Reflect.get(globalThis, 'EvbBrowserDocumentIdb');
                if (typeof productionModule !== 'object' || productionModule === null) {
                    throw new Error('Browser document IDB module was not installed');
                }
                const upgradeBrowserDocumentDatabase = Reflect.get(productionModule, 'upgradeBrowserDocumentDatabase');
                if (typeof upgradeBrowserDocumentDatabase !== 'function') {
                    throw new TypeError('Browser document IDB upgrade function was not installed');
                }
                return new Promise<{
                    legacyName: string | null;
                    stores: string[];
                }>((resolveUpgrade, rejectUpgrade) => {
                    const request = indexedDB.open('evb-viewer-browser-documents', 3);
                    request.onupgradeneeded = () => upgradeBrowserDocumentDatabase(request.result);
                    request.onerror = () => rejectUpgrade(request.error);
                    request.onsuccess = () => {
                        const database = request.result;
                        const stores = Array.from(database.objectStoreNames);
                        const transaction = database.transaction('documents', 'readonly');
                        const getRequest = transaction.objectStore('documents').get('legacy-ref');
                        getRequest.onerror = () => rejectUpgrade(getRequest.error);
                        getRequest.onsuccess = () => {
                            const record = getRequest.result as {name?: string} | undefined;
                            database.close();
                            resolveUpgrade({
                                legacyName: record?.name ?? null,
                                stores,
                            });
                        };
                    };
                });
            });

            expect(result.stores).toEqual([
                'document-chunks',
                'documents',
                'workspace-recovery',
            ]);
            expect(result.legacyName).toBe('legacy.pdf');
        } finally {
            await browser.close();
        }
    }, 30_000);

    it('isolates simultaneous window journals and enforces per-owner generations', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
                await new Promise<void>((resolveDelete) => {
                    const request = indexedDB.deleteDatabase('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => resolveDelete();
                });
            });
            await page.addScriptTag({path: recoveryBundlePath});

            const result = await page.evaluate(async () => {
                const store = Reflect.get(globalThis, 'EvbBrowserWorkspaceRecovery') as {
                    claimBrowserWorkspaceRecoveryOwner?: (
                        sourceOwnerId: string,
                        targetOwnerId: string,
                        generation: number,
                    ) => Promise<unknown>;
                    loadBrowserWorkspaceRecoveries?: () => Promise<unknown>;
                    saveBrowserWorkspaceRecovery?: (
                        ownerId: string,
                        generation: number,
                        checkpoint: unknown,
                        snapshotRefs: string[],
                    ) => Promise<unknown>;
                };
                const buildCheckpoint = (tabId: string, snapshotRef: string, capturedAt: number) => ({
                    version: 1,
                    capturedAt,
                    activePaneId: `pane-${tabId}`,
                    activeTabId: tabId,
                    layout: {
                        type: 'leaf',
                        paneId: `pane-${tabId}`,
                    },
                    panes: [{
                        paneId: `pane-${tabId}`,
                        tabIds: [tabId],
                        activeTabId: tabId,
                    }],
                    tabs: [{
                        tabId,
                        paneId: `pane-${tabId}`,
                        fileName: `${tabId}.pdf`,
                        sourceRef: snapshotRef,
                        workingCopyRef: snapshotRef,
                        requiresSaveAsOnFirstSave: true,
                        isDirty: true,
                        isDjvu: false,
                        currentPage: 1,
                        zoom: 1,
                        zoomMode: 'custom',
                    }],
                });
                const save = store.saveBrowserWorkspaceRecovery!;
                const loadAll = store.loadBrowserWorkspaceRecoveries!;
                const ownerARef = 'browser://documents/window-a-recovery.pdf';
                const ownerBRef = 'browser://documents/window-b-recovery.pdf';
                const first = await Promise.all([
                    save('window:100', 0, buildCheckpoint('tab-a', ownerARef, 1), [ownerARef]),
                    save('window:200', 0, buildCheckpoint('tab-b', ownerBRef, 2), [ownerBRef]),
                ]);
                const stale = await save(
                    'window:100',
                    0,
                    buildCheckpoint('tab-a-stale', ownerARef, 3),
                    [ownerARef],
                );
                const claimed = await store.claimBrowserWorkspaceRecoveryOwner!(
                    'window:200',
                    'window:300',
                    1,
                );
                const recordsAfterFirstClaim = await loadAll();
                const claimedRemaining = await store.claimBrowserWorkspaceRecoveryOwner!(
                    'window:100',
                    'window:400',
                    1,
                );
                return {
                    claimed,
                    claimedRemaining,
                    first,
                    stale,
                    recordsAfterFirstClaim,
                    recordsAfterSecondClaim: await loadAll(),
                };
            });

            expect(result.first).toEqual([
                {
                    saved: true,
                    generation: 1,
                },
                {
                    saved: true,
                    generation: 1,
                },
            ]);
            expect(result.stale).toEqual({
                saved: false,
                generation: 1,
            });
            expect(result.claimed).toEqual({
                claimed: true,
                generation: 2,
            });
            expect(result.recordsAfterFirstClaim).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    ownerId: 'window:100',
                    generation: 1,
                }),
                expect.objectContaining({
                    ownerId: 'window:300',
                    generation: 2,
                }),
            ]));
            expect(result.claimedRemaining).toEqual({
                claimed: true,
                generation: 2,
            });
            expect(result.recordsAfterSecondClaim).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    ownerId: 'window:300',
                    generation: 2,
                }),
                expect.objectContaining({
                    ownerId: 'window:400',
                    generation: 2,
                }),
            ]));
        } finally {
            await browser.close();
        }
    }, 30_000);
});
