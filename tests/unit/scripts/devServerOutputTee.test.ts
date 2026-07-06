import {
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEV_OUTPUT_TEE_DISABLED_ENV,
    createDevServerOutputTee,
    formatDevServerOutputTeeTimestamp,
    sanitizeDevServerOutputFileStem,
} from '@scripts/electron-run/devServerOutputTee';

const tempRoots: string[] = [];

function createTempBaseDir() {
    const dir = mkdtempSync(join(tmpdir(), 'evb-dev-server-output-tee-'));
    tempRoots.push(dir);
    return dir;
}

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

describe('dev server output tee', () => {
    afterEach(() => {
        for (const dir of tempRoots.splice(0)) {
            rmSync(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses stable timestamp and file-stem names', () => {
        expect(formatDevServerOutputTeeTimestamp(new Date('2026-07-06T10:11:12.345Z')))
            .toBe('2026-07-06T10-11-12-345Z');
        expect(sanitizeDevServerOutputFileStem('Nuxt Dev Server'))
            .toBe('nuxt-dev-server');
        expect(() => sanitizeDevServerOutputFileStem('***')).toThrow(/Invalid dev output tee file stem/u);
    });

    it('writes a self-describing scratch run with stream files and latest pointers', () => {
        const baseDir = createTempBaseDir();
        const tee = createDevServerOutputTee({
            sessionName: 'unit-session',
            baseDir,
            now: new Date('2026-07-06T10:11:12.345Z'),
            pid: 12345,
            metadataFileName: 'unit-run.json',
            owner: 'unit test',
        });

        expect(tee.runDir).toBe(join(baseDir, 'unit-session', '2026-07-06T10-11-12-345Z-pid-12345'));

        tee.write('Nuxt Dev Server', 'stdout', 'ready\n');
        tee.write('Electron Main Process', 'stderr', Buffer.from('boom\n'));
        tee.close();

        expect(readFileSync(join(tee.runDir, 'nuxt-dev-server.stdout.log'), 'utf8')).toBe('ready\n');
        expect(readFileSync(join(tee.runDir, 'electron-main-process.stderr.log'), 'utf8')).toBe('boom\n');
        expect(readFileSync(join(tee.runDir, 'nuxt-dev-server.combined.log'), 'utf8')).toContain('stdout] ready');

        expect(readJsonFile<{
            owner: string;
            sessionName: string;
        }>(join(tee.runDir, 'unit-run.json'))).toMatchObject({
            owner: 'unit test',
            sessionName: 'unit-session',
        });
        expect(readJsonFile<{runDir: string}>(join(baseDir, 'latest-run.json')).runDir).toBe(tee.runDir);
        expect(readJsonFile<{runDir: string}>(join(baseDir, 'unit-session', 'latest-run.json')).runDir).toBe(tee.runDir);
    });

    it('can be explicitly disabled for callers that allow it', () => {
        expect(createDevServerOutputTee({
            env: {[DEV_OUTPUT_TEE_DISABLED_ENV]: '1'},
            allowDisabled: true,
        })).toBeNull();
        expect(() => createDevServerOutputTee({ env: { [DEV_OUTPUT_TEE_DISABLED_ENV]: '1' } })).toThrow(/disabled/u);
    });
});
