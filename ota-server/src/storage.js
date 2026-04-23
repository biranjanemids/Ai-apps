'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

function getPackagesDir() {
  const dir = path.resolve(process.env.PACKAGES_DIR || './data/packages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function computeSha256(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function savePackageFile(buffer, originalName, version) {
  const dir = getPackagesDir();
  const safeName = `${version}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const filepath = path.join(dir, safeName);
  fs.writeFileSync(filepath, buffer);
  const sha256 = await computeSha256(filepath);
  const stat = fs.statSync(filepath);
  return { filepath, filename: safeName, sha256, fileSize: stat.size };
}

function validatePackageZip(filepath) {
  const zip = new AdmZip(filepath);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('manifest.json missing from zip root');

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }

  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error('manifest.json missing valid semver version');
  }
  if (!manifest.targets || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error('manifest.json targets must be a non-empty array');
  }
  if (!manifest.files || !Array.isArray(manifest.files)) {
    throw new Error('manifest.json files must be an array');
  }
  for (const file of manifest.files) {
    if (!zip.getEntry(file.source)) {
      throw new Error(`File referenced in manifest not found in zip: ${file.source}`);
    }
  }

  return manifest;
}

function getPackageFilepath(filename) {
  return path.join(getPackagesDir(), filename);
}

function deletePackageFile(filename) {
  const fp = getPackageFilepath(filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = { savePackageFile, computeSha256, validatePackageZip, getPackageFilepath, deletePackageFile };
