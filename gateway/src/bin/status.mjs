import { controlStatus as status } from '../lib/control-plane.mjs';
import { currentTopicStatus } from '../lib/topic-status.mjs';

const snapshot = { ...await status(), currentTopic: await currentTopicStatus() };
const appId = process.env.BOTMUX_LARK_APP_ID;
if (appId) {
  const profiles = snapshot.profiles.filter(profile => profile.appId === appId);
  if (!profiles.length) {
    process.stderr.write('Gateway Bot identity is unknown.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ...snapshot, profiles }, null, 2) + '\n');
  }
} else {
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}
