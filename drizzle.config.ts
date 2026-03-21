import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.NUXT_ANALYTICS_DATABASE_URL
    || process.env.ANALYTICS_DATABASE_URL
    || process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('Expected NUXT_ANALYTICS_DATABASE_URL, ANALYTICS_DATABASE_URL, or DATABASE_URL');
}

export default defineConfig({
    out: './drizzle',
    schema: './server/db/schema.ts',
    dialect: 'postgresql',
    dbCredentials: { url: databaseUrl },
});
