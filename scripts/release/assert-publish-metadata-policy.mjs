#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertPublishUpdaterMetadataPolicy } from './policy.mjs';

const artifactsDir = resolve(process.cwd(), process.argv[2] ?? 'artifacts');
const artifactNames = readdirSync(artifactsDir);

assertPublishUpdaterMetadataPolicy(artifactNames, process.env);
process.stdout.write('Publish updater metadata policy passed.\n');
