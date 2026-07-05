import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const {
    parseArchitectureRootsArg,
    parseArchitectureScopeArg,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/architecture/architectureCliArgs.mjs')).href);

describe('architecture CLI argument parsing', () => {
    it('returns null when roots are omitted', () => {
        expect(parseArchitectureRootsArg([])).toBeNull();
    });

    it('normalizes comma-delimited relative roots', () => {
        expect(parseArchitectureRootsArg(['--roots= app ,electron/features/agent,,packages\\contracts '])).toEqual([
            'app',
            'electron/features/agent',
            'packages/contracts',
        ]);
    });

    it('filters absolute roots', () => {
        expect(parseArchitectureRootsArg([`--roots=app,${resolve(process.cwd(), 'electron')},scripts`])).toEqual([
            'app',
            'scripts',
        ]);
    });

    it('uses the caller default when scope is omitted', () => {
        expect(parseArchitectureScopeArg([], {defaultScope: 'focused'})).toBe('focused');
        expect(parseArchitectureScopeArg([])).toBe('all');
    });

    it('parses supported scopes case-insensitively', () => {
        expect(parseArchitectureScopeArg(['--scope=FOCUSED'])).toBe('focused');
        expect(parseArchitectureScopeArg(['--scope= all '])).toBe('all');
    });

    it('rejects unsupported scopes', () => {
        expect(() => parseArchitectureScopeArg(['--scope=everything'])).toThrow(
            'Unsupported --scope value: --scope=everything',
        );
    });
});
