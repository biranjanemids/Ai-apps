'use strict';
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

function validateManifest(manifest) {
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error('manifest.json: missing or invalid version (semver required)');
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error('manifest.json: targets must be a non-empty array');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('manifest.json: files must be an array');
  }
  for (const f of manifest.files) {
    if (!f.source || !f.destination) {
      throw new Error(`manifest.json: each file entry must have source and destination`);
    }
  }
}

function mergeFileMappings(manifestFiles, serverMappings) {
  if (!serverMappings || serverMappings.length === 0) return manifestFiles;
  // Build lookup from source_path → server mapping
  const bySource = {};
  for (const m of serverMappings) {
    bySource[m.source_path] = m;
  }
  return manifestFiles.map(f => {
    const override = bySource[f.source];
    if (override) {
      return {
        source: f.source,
        destination: override.dest_path,
        file_type: override.file_type || f.file_type || 'binary',
        backup: override.backup !== undefined ? override.backup : (f.backup !== false)
      };
    }
    return f;
  });
}

function extractPackage(zipPath, workDir) {
  const extractDir = path.join(workDir, `ota_work_${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);
  return extractDir;
}

function loadPackage(zipPath, workDir, serverMappings = []) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Zip not found: ${zipPath}`);
  }

  const extractDir = extractPackage(zipPath, workDir);

  const manifestPath = path.join(extractDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found in package root');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid manifest.json: ${e.message}`);
  }

  validateManifest(manifest);

  const files = mergeFileMappings(manifest.files, serverMappings);

  const scripts = {};
  if (manifest.scripts) {
    if (manifest.scripts.pre_update) {
      scripts.preUpdate = path.join(extractDir, manifest.scripts.pre_update);
    }
    if (manifest.scripts.post_update) {
      scripts.postUpdate = path.join(extractDir, manifest.scripts.post_update);
    }
  }

  return {
    manifest,
    extractDir,
    targets: manifest.targets || [],
    files: files.map(f => ({
      ...f,
      sourcePath: path.join(extractDir, f.source)
    })),
    scripts,
    healthCheck: manifest.health_check || { type: 'service_running', timeout_seconds: 60 },
    rollbackOnFailure: manifest.rollback_on_failure !== false
  };
}

function cleanupExtract(extractDir) {
  if (extractDir && fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

module.exports = { loadPackage, cleanupExtract };
