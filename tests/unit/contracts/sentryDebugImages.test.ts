import {
    describe,
    expect,
    it,
} from 'vitest';
import {buildSentrySourceMapDebugImages} from '@contracts/diagnostics/sentryDebugImages';

describe('Sentry source-map Debug Images', () => {
    it('fails closed for invalid, conflicting, and source-module mappings', () => {
        expect(buildSentrySourceMapDebugImages([
            {module: 'dist-electron/main.js'},
            {module: '_nuxt/app.js'},
            {module: 'electron/private.ts'},
        ], {
            'file:///opt/EVB Viewer/resources/app.asar/dist-electron/main.js':
                '11111111-1111-4111-8111-111111111111',
            'file:///other/app.asar/dist-electron/main.js':
                '22222222-2222-4222-8222-222222222222',
            'https://evb-viewer.com/_nuxt/app.js': 'not-a-debug-id',
            'file:///opt/EVB Viewer/resources/app.asar/electron/private.ts':
                '33333333-3333-4333-8333-333333333333',
        })).toEqual([]);
    });

    it('deduplicates matching bundle frames', () => {
        expect(buildSentrySourceMapDebugImages([
            {module: 'server-bundle/chunks/nitro.mjs'},
            {module: 'server-bundle/chunks/nitro.mjs'},
        ], {'/var/task/chunks/nitro.mjs':
                '44444444-4444-4444-8444-444444444444'})).toEqual([{
            type: 'sourcemap',
            code_file: 'server-bundle/chunks/nitro.mjs',
            debug_id: '44444444-4444-4444-8444-444444444444',
        }]);
    });
});
