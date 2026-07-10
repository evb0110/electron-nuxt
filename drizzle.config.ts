import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.NUXT_ANALYTICS_DATABASE_URL
    || process.env.ANALYTICS_DATABASE_URL
    || process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('Expected NUXT_ANALYTICS_DATABASE_URL, ANALYTICS_DATABASE_URL, or DATABASE_URL');
}

export default defineConfig({
    out: relative(process.cwd(), fileURLToPath(new URL('./drizzle', import.meta.url))),
    schema: relative(
        process.cwd(),
        fileURLToPath(new URL('./server/db/viewerAnalyticsEvent.ts', import.meta.url)),
    ),
    dialect: 'postgresql',
    dbCredentials: { url: databaseUrl },
});
