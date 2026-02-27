#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const chunksDir = '/app/apps/studio/.next/static/chunks';

const patterns = [
  {
    from: 'return{endpoint:t.IS_PLATFORM?`https://${n}`:"undefined"!=typeof window?window.location.origin:`${i}://${n}`}}',
    to: 'return{endpoint:"undefined"!=typeof window?window.location.origin:`${t.IS_PLATFORM?"https":i}://${n}`}}',
  },
  {
    from: 'return{endpoint:`${t.IS_PLATFORM?"https":i}://${n}`}}',
    to: 'return{endpoint:"undefined"!=typeof window?window.location.origin:`${t.IS_PLATFORM?"https":i}://${n}`}}',
  },
  {
    from: 'return{endpoint:t.IS_PLATFORM?`https://${n}`:`${i}://${n}`}}',
    to: 'return{endpoint:"undefined"!=typeof window?window.location.origin:`${t.IS_PLATFORM?"https":i}://${n}`}}',
  },
];

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  for (const { from, to } of patterns) {
    if (content.includes(from)) {
      content = content.replace(from, to);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
  }

  return changed;
}

function main() {
  if (!fs.existsSync(chunksDir)) {
    console.log('[studio-upload-patch] chunks directory not found, skipping');
    return;
  }

  const files = fs.readdirSync(chunksDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(chunksDir, name));

  let patchedCount = 0;
  for (const filePath of files) {
    if (patchFile(filePath)) patchedCount += 1;
  }

  if (patchedCount > 0) {
    console.log(`[studio-upload-patch] patched ${patchedCount} chunk(s)`);
  } else {
    console.log('[studio-upload-patch] no matching chunk pattern found (already patched or upstream changed)');
  }
}

main();
