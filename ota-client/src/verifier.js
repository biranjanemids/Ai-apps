'use strict';
const crypto = require('crypto');
const fs = require('fs');

function computeSha256(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyPackage(filepath, expectedHash) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Package file not found: ${filepath}`);
  }
  const actual = await computeSha256(filepath);
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `SHA256 mismatch: expected ${expectedHash}, got ${actual}`
    );
  }
  return true;
}

module.exports = { verifyPackage, computeSha256 };
