import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readProjectFile(relativePath) {
    return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function assertContains(source, expected, label) {
    if (!source.includes(expected)) {
        throw new Error(`${label} is missing ${expected}`);
    }
}

export function assertDrizzleSchemaWiring() {
    const drizzleConfig = readProjectFile('drizzle.config.ts');
    const schema = readProjectFile('server/db/viewerAnalyticsEvent.ts');
    const packageJson = JSON.parse(readProjectFile('package.json'));
    const scripts = packageJson.scripts ?? {};

    assertContains(drizzleConfig, 'relative(process.cwd()', 'drizzle.config.ts');
    assertContains(
        drizzleConfig,
        'new URL(\'./server/db/viewerAnalyticsEvent.ts\', import.meta.url)',
        'drizzle.config.ts',
    );
    assertContains(drizzleConfig, 'dialect: \'postgresql\'', 'drizzle.config.ts');
    assertContains(schema, 'pgTable(', 'viewer analytics schema');
    assertContains(schema, 'viewer_analytics_event', 'viewer analytics schema');

    for (const scriptName of [
        'db:generate',
        'db:migrate',
        'db:check',
    ]) {
        if (typeof scripts[scriptName] !== 'string') {
            throw new Error(`package.json is missing ${scriptName}`);
        }
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        assertDrizzleSchemaWiring();
        console.log('Drizzle schema wiring check passed.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
