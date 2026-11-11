// Regenerate docs/agent-guide.*.md, the public copy of what `zenextia init`
// writes. `npm test` fails when they drift from src/guide/.
import fs from 'node:fs';

import { GUIDE_LANGUAGES, agentGuide } from '../src/guide.js';

for (const lang of GUIDE_LANGUAGES) {
  const file = new URL(`../docs/agent-guide.${lang}.md`, import.meta.url);
  fs.writeFileSync(file, agentGuide({ lang }), 'utf8');
  console.log(`wrote docs/agent-guide.${lang}.md`);
}
