import { defineConfig } from 'vitest/config';
import {
    electronE2ETeardownTimeoutMs,
    unitSlowTestThresholdMs,
    vitestProjects,
} from './vitest.shared.config';

export default defineConfig({ test: {
    projects: vitestProjects,
    slowTestThreshold: unitSlowTestThresholdMs,
    teardownTimeout: electronE2ETeardownTimeoutMs,
    coverage: {
        provider: 'v8',
        reporter: [
            'text',
            'json-summary',
            'lcov',
        ],
    },
} });
