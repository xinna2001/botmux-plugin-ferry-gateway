import { status } from '../lib/gateway.mjs';
export default {
  'gateway:status': { description: 'Read gateway health and acceleration state', async run() { return JSON.stringify(await status(), null, 2); } },
};
