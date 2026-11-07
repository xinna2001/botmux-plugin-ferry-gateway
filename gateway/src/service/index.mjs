export default {
  mode: 'auto',
  port: 18739,
  pm2: { script: 'service/runner.mjs', cwd: '.', autorestart: true, killTimeoutMs: 5000 },
  urls({ port }) { return { healthUrl: `http://127.0.0.1:${port}/healthz` }; },
};
