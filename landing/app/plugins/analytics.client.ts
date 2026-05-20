export default defineNuxtPlugin(() => {
    const router = useRouter();

    router.afterEach((to) => {
        trackPageView({
            path: to.path,
            referrer: document.referrer || null,
        });
    });
});
