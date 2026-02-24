/* eslint-disable no-restricted-imports */
import type { TLocale } from './locale-codes';

export const LOCALE_DEFINITIONS: Array<{
    code: TLocale;
    file: string;
    name: string;
}> = [
    {
        code: 'en',
        file: 'en.ts',
        name: 'English',
    },
    {
        code: 'ru',
        file: 'ru.ts',
        name: 'Русский',
    },
    {
        code: 'fr',
        file: 'fr.ts',
        name: 'Français',
    },
    {
        code: 'de',
        file: 'de.ts',
        name: 'Deutsch',
    },
    {
        code: 'es',
        file: 'es.ts',
        name: 'Español',
    },
    {
        code: 'it',
        file: 'it.ts',
        name: 'Italiano',
    },
    {
        code: 'pt',
        file: 'pt.ts',
        name: 'Português',
    },
    {
        code: 'nl',
        file: 'nl.ts',
        name: 'Nederlands',
    },
];
