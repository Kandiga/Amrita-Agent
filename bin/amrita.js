#!/usr/bin/env node
// Thin launcher: Node >= 23.6 strips TypeScript types natively.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await import(join(root, 'src', 'cli', 'main.ts'));
