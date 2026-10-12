import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../../../.temp/tests/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
for (const name of ['TMP', 'TEMP', 'TMPDIR']) process.env[name] = path.resolve(directory);
