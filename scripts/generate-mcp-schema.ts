import { writeFile } from 'node:fs/promises';
import { toolDefinitions } from '../src/mcp-tools';

await writeFile(new URL('../docs/mcp-tools.json',import.meta.url),JSON.stringify({tools:toolDefinitions()},null,2)+'\n');
