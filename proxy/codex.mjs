import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { providerConfig } from './providers.mjs';
import { codexArgs } from './codex-config.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = providerConfig();
const port = process.env.RAYTACE_PORT || '8797';

// Codex itself, pointed at RayTrace's proxy so every model call is recorded.
const child = spawn('codex', codexArgs(config, process.argv.slice(2), port), { stdio: 'inherit' });
child.on('error', (error) => { console.error(`Could not launch Codex: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
