import { startJob, getJobStatus } from '../gateway/src/lib/setup.mjs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const home = process.argv[2];
await startJob('bootstrap', async job => {
  job.progress = 'background fixture preparing';
  job.loginUrl = 'https://sso.bytedance.com/login?cross-process=fixture';
  while (!await access(join(home, 'finish')).then(() => true, () => false))
    await new Promise(resolve => setTimeout(resolve, 10));
}, home);
process.stdout.write('started\n');
while ((await getJobStatus(home)).state === 'running')
  await new Promise(resolve => setTimeout(resolve, 10));
