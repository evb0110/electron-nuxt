import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDefaultScanCleanupSettingsFile,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS,
} from '@contracts/scanCleanupSettings';
import {createScanCleanupSettingsStore} from '@electron/features/scan-cleanup/createScanCleanupSettingsStore';

const temporaryDirectories: string[] = [];

async function createStoreFile() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-settings-'));
    temporaryDirectories.push(directory);
    return join(directory, 'scan-cleanup-settings.json');
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        recursive: true,
        force: true,
    })));
});

describe('file-backed scan-cleanup settings store', () => {
    it('keeps the previous file intact when replacement is interrupted', async () => {
        const filePath = await createStoreFile();
        const initial = createDefaultScanCleanupSettingsFile();
        await writeFile(filePath, `${JSON.stringify(initial)}\n`, 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            replace: async () => {
                throw new Error('simulated interrupted promotion');
            },
        });

        await expect(store.update({settings: {
            ...initial.settings,
            readingOrder: 'rtl',
        }})).rejects.toThrow('simulated interrupted promotion');
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(initial);
    });

    it('quarantines malformed JSON, preserves its bytes, and atomically writes defaults', async () => {
        const filePath = await createStoreFile();
        const corruptRaw = '{"schemaVersion":1,"settings":';
        await writeFile(filePath, corruptRaw, 'utf8');
        const logger = {warn: vi.fn()};
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        await expect(store.get()).resolves.toEqual(createDefaultScanCleanupSettingsFile());
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(createDefaultScanCleanupSettingsFile());
        const directory = join(filePath, '..');
        const quarantinedName = (await readdir(directory))
            .find(name => /^scan-cleanup-settings\.json\.\d+\.corrupt$/u.test(name));
        expect(quarantinedName).toBeDefined();
        await expect(readFile(join(directory, quarantinedName!), 'utf8')).resolves.toBe(corruptRaw);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt scan-cleanup settings'));
    });

    it('rejects an unsupported future schema without quarantining or overwriting it', async () => {
        const filePath = await createStoreFile();
        const futureRaw = `${JSON.stringify({
            schemaVersion: 99,
            settings: {},
            documentOverrides: {},
        }, null, 2)}\n`;
        await writeFile(filePath, futureRaw, 'utf8');
        const logger = {warn: vi.fn()};
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        await expect(store.get()).rejects.toThrow('Unsupported scan-cleanup settings schema version: 99');
        expect(await readFile(filePath, 'utf8')).toBe(futureRaw);
        expect(await readdir(join(filePath, '..'))).toEqual(['scan-cleanup-settings.json']);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('merges the legacy export into a SHA-256 key with newest-wins semantics', async () => {
        const filePath = await createStoreFile();
        const sourceSha256 = 'A'.repeat(64);
        const legacyDocumentKey = '/documents/scan.pdf';
        const legacyOverrides = {[legacyDocumentKey]: {
            updatedAt: 20,
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }},
        }};
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => 100,
        });

        const migrated = await store.get({
            legacyStorage: {
                settingsRaw: JSON.stringify({
                    readingOrder: 'rtl',
                    updatedAt: 10,
                }),
                documentOverridesRaw: JSON.stringify(legacyOverrides),
                exportedAtMs: 10,
            },
            sourceSha256,
            legacyDocumentKey,
        });
        expect(migrated.settings.readingOrder).toBe('rtl');
        expect(migrated.documentOverrides).toEqual({[sourceSha256.toLowerCase()]: expect.objectContaining({
            lastUsedAtMs: 20,
            overrides: legacyOverrides[legacyDocumentKey].overrides,
        })});
        expect(migrated.documentOverrides[legacyDocumentKey]).toBeUndefined();

        const updated = await store.update({document: {
            sourceSha256: sourceSha256.toLowerCase(),
            patch: {outputMode: 'grayscale'},
        }});
        expect(updated.documentOverrides[sourceSha256.toLowerCase()]).toMatchObject({
            outputMode: 'grayscale',
            lastUsedAtMs: 100,
        });
    });

    it('resets only page overrides while preserving document margins and output mode', async () => {
        const filePath = await createStoreFile();
        const sourceSha256 = 'd'.repeat(64);
        const initial = createDefaultScanCleanupSettingsFile();
        initial.documentOverrides[sourceSha256] = {
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: null,
            }},
            marginsMm: {
                leftMm: 4,
                topMm: 5,
                rightMm: 6,
                bottomMm: 7,
            },
            outputMode: 'color',
            lastUsedAtMs: 1,
        };
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => 2,
        });

        const updated = await store.update({document: {
            sourceSha256,
            patch: {resetOverrides: true},
        }});

        expect(updated.documentOverrides[sourceSha256]).toEqual({
            marginsMm: initial.documentOverrides[sourceSha256]!.marginsMm,
            outputMode: 'color',
            lastUsedAtMs: 2,
        });
    });

    it('applies deep page-key validation while migrating legacy overrides', async () => {
        const filePath = await createStoreFile();
        const store = createScanCleanupSettingsStore({filePath});

        await expect(store.get({legacyStorage: {
            settingsRaw: null,
            documentOverridesRaw: JSON.stringify({'/documents/scan.pdf': {overrides: {'01': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }}}}),
        }})).rejects.toThrow('page override number');
    });

    it('expires old document overrides on load and keeps recent entries', async () => {
        const filePath = await createStoreFile();
        const now = SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS * 2 + 1_000_000;
        const oldHash = 'b'.repeat(64);
        const freshHash = 'c'.repeat(64);
        const initial = createDefaultScanCleanupSettingsFile();
        initial.documentOverrides = {
            [oldHash]: {lastUsedAtMs: now - SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS - 1},
            [freshHash]: {lastUsedAtMs: now - SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS},
        };
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => now,
        });

        const loaded = await store.get();
        expect(Object.keys(loaded.documentOverrides)).toEqual([freshHash]);
        const persisted = JSON.parse(await readFile(filePath, 'utf8'));
        expect(Object.keys(persisted.documentOverrides)).toEqual([freshHash]);
    });
});
