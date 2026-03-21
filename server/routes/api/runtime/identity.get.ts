import { EVB_RUNTIME_IDENTITY } from '@contracts/runtime-identity';

export default defineEventHandler((event) => {
    setHeader(event, 'cache-control', 'no-store');
    return EVB_RUNTIME_IDENTITY;
});
