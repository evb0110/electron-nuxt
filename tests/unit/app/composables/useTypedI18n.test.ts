import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const useI18nMock = vi.fn();

vi.mock('vue-i18n', () => ({useI18n: (...args: unknown[]) => useI18nMock(...args)}));

describe('useTypedI18n', () => {
    it('exposes safe locale methods when i18n composer does not provide them', async () => {
        useI18nMock.mockReturnValue({ t: (key: string) => key });

        const { useTypedI18n } = await import('@app/composables/useTypedI18n');
        const i18n = useTypedI18n();

        await expect(i18n.setLocale('en')).resolves.toBeUndefined();
        await expect(i18n.loadLocaleMessages('en')).resolves.toBeUndefined();
    });

    it('calls composer locale methods when they are available', async () => {
        const setLocale = vi.fn(async (_locale: string) => {});
        const loadLocaleMessages = vi.fn(async (_locale: string) => {});

        useI18nMock.mockReturnValue({
            t: (key: string) => key,
            setLocale,
            loadLocaleMessages,
        });

        const { useTypedI18n } = await import('@app/composables/useTypedI18n');
        const i18n = useTypedI18n();

        await i18n.setLocale('fr');
        await i18n.loadLocaleMessages('fr');

        expect(setLocale).toHaveBeenCalledWith('fr');
        expect(loadLocaleMessages).toHaveBeenCalledWith('fr');
    });

    it('types translation keys from schema', async () => {
        useI18nMock.mockReturnValue({ t: (key: string) => key });

        const { useTypedI18n } = await import('@app/composables/useTypedI18n');
        const i18n = useTypedI18n();

        expect(i18n.t('contextMenu.copySelectionToClipboard')).toBe('contextMenu.copySelectionToClipboard');
        expect(i18n.t('export.scopeAll', { count: 2 })).toBe('export.scopeAll');

        // @ts-expect-error invalid translation key should be rejected
        i18n.t('contextMenu.copySelectionClipboard');

        // @ts-expect-error required params should be enforced
        i18n.t('export.scopeAll');

        // @ts-expect-error invalid params should be rejected
        i18n.t('export.scopeAll', { page: 2 });
    });
});
