import { status } from '../lib/gateway.mjs';

const snapshot = await status();
const appId = process.env.BOTMUX_LARK_APP_ID;
if (appId) {
  const profiles = snapshot.profiles.filter(profile => profile.appId === appId && profile.pluginEnabled);
  if (!profiles.length) {
    process.stderr.write('Gateway plugin is not active for this Bot.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ...snapshot, profiles }, null, 2) + '\n');
  }
} else {
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}
