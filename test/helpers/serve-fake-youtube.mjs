// Starts the fake googlevideo CDN and runs a command with the env pointing the server at the fakes.
// Offline development:  node test/helpers/serve-fake-youtube.mjs npm run dev
// Then paste e.g. https://youtu.be/dQw4w9WgXcQ (any 11-char id) - the fake serves synthetic media.
import { spawn } from 'node:child_process';
import { startFakeCdn, fakeYoutubeEnv } from './fakeYoutube.js';

const cdn = await startFakeCdn();
const [cmd, ...args] = process.argv.slice(2);
console.log(`[fake-youtube] CDN at ${cdn.base}`);
const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...fakeYoutubeEnv(cdn) } });
const stop = () => { child.kill('SIGTERM'); cdn.close().then(() => process.exit()); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', code => cdn.close().then(() => process.exit(code ?? 0)));
