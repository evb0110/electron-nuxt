import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface IDrizzleSchemaModule {assertDrizzleSchemaWiring: () => void;}

const {assertDrizzleSchemaWiring} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-drizzle-schema.mjs')).href
) as IDrizzleSchemaModule;

describe('drizzle schema wiring', () => {
    it('matches the checked-in config, schema, and package scripts', () => {
        expect(() => {
            assertDrizzleSchemaWiring();
        }).not.toThrow();
    });
});
