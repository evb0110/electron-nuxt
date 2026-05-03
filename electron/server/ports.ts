import { createServer } from 'net';

export async function reserveLocalPort() {
    return new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : null;
            probe.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }
                if (!port || !Number.isInteger(port) || port <= 0) {
                    reject(new Error('Failed to reserve runtime port'));
                    return;
                }
                resolve(port);
            });
        });
    });
}
