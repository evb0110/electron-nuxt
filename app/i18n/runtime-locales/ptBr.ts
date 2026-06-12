export default defineI18nLocale(async () => {
    const { default: messages } = await import('@i18n-app/messages/ptBr');
    return messages;
});
