import { mkdir, cp, stat } from 'node:fs/promises';
import path from 'node:path';
const destination = path.resolve('dist/coursepilot');
await mkdir(destination, { recursive: true });
await cp(path.resolve('extension'), destination, { recursive: true });
await cp(path.resolve('README.md'), path.join(destination, 'README.md'));
await stat(path.join(destination, 'manifest.json'));
console.log(`Ready to load unpacked: ${destination}`);
