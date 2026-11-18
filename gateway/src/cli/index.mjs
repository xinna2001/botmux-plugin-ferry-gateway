import { controlStatus as status } from '../lib/control-plane.mjs';
import { currentTopicStatus } from '../lib/topic-status.mjs';
export default {
  'gateway:status': { description: 'Read gateway health, defaults and actual current-topic acceleration state',
    async run() { return JSON.stringify({ ...await status(), currentTopic: await currentTopicStatus() }, null, 2); } },
};
