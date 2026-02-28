import type {
    TLocale,
    TTranslateFn,
} from '~/i18n/locales';
import { createTypedI18nComposer } from '@i18n-core';

export function useTypedI18n() {
    const composer = useI18n();
    return createTypedI18nComposer<typeof composer, TTranslateFn, TLocale>(composer);
}

export type TLandingTypedI18nComposer = ReturnType<typeof useTypedI18n>;
