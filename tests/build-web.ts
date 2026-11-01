import { build } from 'vite';
export default async function setup() {
 const previous = process.env.NODE_ENV;
 process.env.NODE_ENV = 'production';
 try {await build({ configFile: 'vite.config.ts', logLevel: 'warn' });}
 finally {if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;}
}
