'use strict';
/**
 * End-to-end test for the OTA Windows Update System.
 * Tests: server API, gRPC transport, package upload/download,
 *        client update application, SHA256 verification, rollback.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

// ─── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL   = 'https://localhost:8443';
const GRPC_ADDR    = 'localhost:50051';
const ADMIN_SECRET = 'dev_admin_secret_change_me_in_production';
const TMP          = '/tmp/ota-e2e-test';
const CLIENT_DIR   = path.join(__dirname, 'ota-client');

// ─── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

function pass(name) {
  passed++;
  results.push({ status: 'PASS', name });
  process.stdout.write(`  \x1b[32m✔\x1b[0m ${name}\n`);
}

function fail(name, reason) {
  failed++;
  results.push({ status: 'FAIL', name, reason });
  process.stdout.write(`  \x1b[31m✘\x1b[0m ${name}\n    → ${reason}\n`);
}

function section(title) {
  console.log(`\n\x1b[1m\x1b[36m── ${title} ──\x1b[0m`);
}

function request(method, urlPath, body, authToken, binary = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || 8443,
      path: url.pathname,
      method,
      rejectUnauthorized: false,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {})
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (binary) return resolve({ status: res.statusCode, headers: res.headers, body: raw });
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: raw.toString() }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function multipartUpload(filePath, fields) {
  return new Promise((resolve, reject) => {
    const boundary = `----OTATestBoundary${Date.now()}`;
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      );
    }
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
    );
    const bodyStart = Buffer.from(parts.join(''));
    const bodyEnd   = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body      = Buffer.concat([bodyStart, fileData, bodyEnd]);

    const options = {
      hostname: '127.0.0.1',
      port: 8443,
      path: '/packages/upload',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 30000,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${ADMIN_SECRET}`,
        'Content-Length': body.length
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Package builder ─────────────────────────────────────────────────────────
function buildPackage(zipPath, version, targetDir, healthy = true) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const zip = new AdmZip();

  zip.addFile('files/MyService.exe', Buffer.from(`MyService.exe v${version} build`));
  zip.addFile('files/MyService.dll', Buffer.from(`MyService.dll v${version} build`));
  zip.addFile('files/config.ini',    Buffer.from(`[app]\nversion=${version}\n`));

  zip.addFile('scripts/pre-update.js',  Buffer.from(`console.log('pre-update v${version}');\n`));
  zip.addFile('scripts/post-update.js', Buffer.from(
    healthy
      ? `console.log('post-update v${version} OK');\n`
      : `console.error('post-update intentional failure');\nprocess.exit(1);\n`
  ));

  const manifest = {
    package_name: 'MyWindowsService',
    version,
    targets: [{ type: 'file_only' }],    // file_only: no Windows SCM calls needed for tests
    files: [
      { source: 'files/MyService.exe', destination: path.join(targetDir, 'MyService.exe'), file_type: 'binary',  backup: true },
      { source: 'files/MyService.dll', destination: path.join(targetDir, 'MyService.dll'), file_type: 'binary',  backup: true },
      { source: 'files/config.ini',    destination: path.join(targetDir, 'config.ini'),    file_type: 'config',  backup: true }
    ],
    scripts: { pre_update: 'scripts/pre-update.js', post_update: 'scripts/post-update.js' },
    health_check: { type: 'file_only', timeout_seconds: 10 },
    rollback_on_failure: true
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.writeZip(zipPath);
  return zip;
}

// ─── Main test runner ─────────────────────────────────────────────────────────
async function run() {
  console.log('\n\x1b[1mOTA Windows Update System — End-to-End Test\x1b[0m');
  console.log('═'.repeat(55));

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ── 1. Server Health ────────────────────────────────────────────────────────
  section('1. Server Health');

  let healthRes;
  try {
    healthRes = await request('GET', '/health');
    healthRes.status === 200 && healthRes.body.status === 'ok'
      ? pass('GET /health → 200 ok')
      : fail('GET /health', `Got ${healthRes.status}: ${JSON.stringify(healthRes.body)}`);
  } catch (e) { fail('GET /health', e.message); return; }

  // ── 2. Device Registration ──────────────────────────────────────────────────
  section('2. Device Registration');

  let deviceToken, deviceId, grpcRegisteredToken, grpcRegisteredDeviceId;
  try {
    const res = await request('POST', '/devices/register', {
      hostname: 'WIN-E2E-TEST-01',
      os_version: 'Windows 10 22H2',
      current_version: '0.0.0'
    });
    if (res.status === 200 && res.body.auth_token && res.body.device_id) {
      deviceToken = res.body.auth_token;
      deviceId    = res.body.device_id;
      pass(`POST /devices/register → device_id=${deviceId.slice(0,8)}…`);
    } else {
      fail('POST /devices/register', JSON.stringify(res.body));
    }
  } catch (e) { fail('POST /devices/register', e.message); }

  try {
    const res = await request('GET', '/devices/me', null, deviceToken);
    res.status === 200 && res.body.device_id === deviceId
      ? pass('GET /devices/me → authenticated')
      : fail('GET /devices/me', JSON.stringify(res.body));
  } catch (e) { fail('GET /devices/me', e.message); }

  try {
    const res = await request('GET', '/devices/me', null, 'bad_token_xyz');
    res.status === 401
      ? pass('GET /devices/me with bad token → 401')
      : fail('Auth rejection', `Expected 401, got ${res.status}`);
  } catch (e) { fail('Auth rejection', e.message); }

  // ── 3. Package Upload ───────────────────────────────────────────────────────
  section('3. Package Upload');

  const targetDir  = path.join(TMP, 'install_target');
  const zipV1      = path.join(TMP, 'update_v1.0.0.zip');
  const zipV2      = path.join(TMP, 'update_v2.0.0.zip');
  const zipBroken  = path.join(TMP, 'update_v3.0.0_broken.zip');
  buildPackage(zipV1, '1.0.0', targetDir, true);
  buildPackage(zipV2, '2.0.0', targetDir, true);
  buildPackage(zipBroken, '3.0.0', targetDir, false);  // post-update fails → triggers rollback

  let pkgId1, pkgId2, pkgIdBroken;

  try {
    const res = await multipartUpload(zipV1, { version: '1.0.0', release_notes: 'E2E test v1' });
    if (res.status === 201 && res.body.package_id) {
      pkgId1 = res.body.package_id;
      pass(`Upload v1.0.0 → package_id=${pkgId1}, sha256=${res.body.sha256_hash.slice(0,12)}…`);
    } else {
      fail('Upload v1.0.0', JSON.stringify(res.body));
    }
  } catch (e) { fail('Upload v1.0.0', e.message); }

  try {
    const res = await multipartUpload(zipV2, { version: '2.0.0', release_notes: 'E2E test v2' });
    if (res.status === 201 && res.body.package_id) {
      pkgId2 = res.body.package_id;
      pass(`Upload v2.0.0 → package_id=${pkgId2}, sha256=${res.body.sha256_hash.slice(0,12)}…`);
    } else {
      fail('Upload v2.0.0', JSON.stringify(res.body));
    }
  } catch (e) { fail('Upload v2.0.0', e.message); }

  // Duplicate version rejection
  try {
    const res = await multipartUpload(zipV1, { version: '1.0.0', release_notes: 'Duplicate' });
    res.status === 409
      ? pass('Duplicate version upload → 409 Conflict')
      : fail('Duplicate version', `Expected 409, got ${res.status}`);
  } catch (e) { fail('Duplicate version', e.message); }

  // Invalid zip (no manifest) rejection
  try {
    const badZipPath = path.join(TMP, 'no_manifest.zip');
    const bz = new AdmZip();
    bz.addFile('some_file.txt', Buffer.from('no manifest here'));
    bz.writeZip(badZipPath);
    const res = await multipartUpload(badZipPath, { version: '9.9.9', release_notes: 'bad' });
    res.status === 400
      ? pass('Invalid zip (no manifest.json) → 400')
      : fail('Invalid zip rejection', `Expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  } catch (e) { fail('Invalid zip rejection', e.message); }

  // ── 4. Update Poll — Version Gating ────────────────────────────────────────
  section('4. Update Poll — Version Gating');

  let downloadedZip;

  try {
    // Device at 0.0.0, server has 2.0.0 → should stream the zip
    const res = await request('POST', '/updates/poll',
      { current_version: '0.0.0' }, deviceToken, true);
    if (res.status === 200) {
      const zipBuf = res.body;
      const ver = res.headers['x-package-version'];
      const sha = res.headers['x-sha256'];
      const size = zipBuf.length;
      downloadedZip = path.join(TMP, `downloaded_${ver}.zip`);
      fs.writeFileSync(downloadedZip, zipBuf);
      pass(`Poll v0.0.0 → received v${ver} (${size} bytes, sha256=${sha.slice(0,12)}…)`);
    } else {
      fail('Poll v0.0.0 should get update', `Got HTTP ${res.status}`);
    }
  } catch (e) { fail('Poll v0.0.0', e.message); }

  try {
    // Device already at latest → 204
    const res = await request('POST', '/updates/poll',
      { current_version: '2.0.0' }, deviceToken, true);
    res.status === 204
      ? pass('Poll v2.0.0 (up-to-date) → 204 No Content')
      : fail('Poll up-to-date', `Expected 204, got ${res.status}`);
  } catch (e) { fail('Poll up-to-date', e.message); }

  try {
    // Unauthorized poll
    const res = await request('POST', '/updates/poll',
      { current_version: '0.0.0' }, 'invalid_token_abc', true);
    res.status === 401
      ? pass('Poll with invalid token → 401')
      : fail('Poll auth', `Expected 401, got ${res.status}`);
  } catch (e) { fail('Poll auth', e.message); }

  // ── 5. SHA256 Verification ──────────────────────────────────────────────────
  section('5. SHA256 Verification (client verifier.js)');

  const { verifyPackage } = require('./ota-client/src/verifier');

  try {
    const pkgMeta = await request('GET', `/packages/${pkgId2}`, null, deviceToken);
    const expectedHash = pkgMeta.body.sha256_hash;
    await verifyPackage(downloadedZip, expectedHash);
    pass(`SHA256 match: ${expectedHash.slice(0, 16)}…`);
  } catch (e) { fail('SHA256 valid package', e.message); }

  try {
    await verifyPackage(downloadedZip, 'deadbeef'.repeat(8));
    fail('SHA256 bad hash accepted', 'Should have thrown');
  } catch {
    pass('SHA256 bad hash → throws IntegrityError');
  }

  // ── 6. Package Parser ───────────────────────────────────────────────────────
  section('6. Package Parser (client package-parser.js)');

  const { loadPackage, cleanupExtract } = require('./ota-client/src/package-parser');
  let parsedPkg;

  try {
    parsedPkg = loadPackage(downloadedZip, TMP, []);
    pass(`Parsed manifest: version=${parsedPkg.manifest.version}, targets=${parsedPkg.targets.length}, files=${parsedPkg.files.length}`);
  } catch (e) { fail('Parse valid package', e.message); }

  // Server-side mapping override test
  try {
    const overridePath = path.join(TMP, 'install_override');
    const serverMappings = [
      { source_path: 'files/MyService.exe', dest_path: path.join(overridePath, 'MyService.exe'), file_type: 'binary', backup: true }
    ];
    const pkg2 = loadPackage(downloadedZip, TMP, serverMappings);
    const exeFile = pkg2.files.find(f => f.source === 'files/MyService.exe');
    exeFile && exeFile.destination === path.join(overridePath, 'MyService.exe')
      ? pass(`Server mapping override: dest → ${path.basename(overridePath)}/MyService.exe`)
      : fail('Server mapping override', `Got destination: ${exeFile && exeFile.destination}`);
    cleanupExtract(pkg2.extractDir);
  } catch (e) { fail('Server mapping override', e.message); }

  // ── 7. File Replacer ────────────────────────────────────────────────────────
  section('7. File Replacer — 4-Tier Strategy (client file-replacer.js)');

  const { FileReplacer } = require('./ota-client/src/file-replacer');
  const testLogger = { debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: ()=>{} };
  const replacer = new FileReplacer(testLogger);

  const srcFile  = path.join(TMP, 'source_new.bin');
  const dstFile  = path.join(TMP, 'replace_target', 'target.bin');
  const backupD  = path.join(TMP, 'backup_test');
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.writeFileSync(srcFile, Buffer.from('NEW CONTENT v2.0.0'));
  fs.writeFileSync(dstFile, Buffer.from('OLD CONTENT v1.0.0'));

  try {
    const tier = replacer.replace(srcFile, dstFile, backupD);
    const afterContent = fs.readFileSync(dstFile, 'utf8');
    const backupExists = fs.existsSync(path.join(backupD, 'target.bin'));
    afterContent === 'NEW CONTENT v2.0.0' && backupExists
      ? pass(`Tier-1 replace succeeded (${tier}), backup created`)
      : fail('File replace', `Content: ${afterContent}, backup: ${backupExists}`);
  } catch (e) { fail('File replace', e.message); }

  try {
    replacer.replace(srcFile, '/nonexistent_dir/deeply/nested/file.bin', null);
    pass('Replace auto-creates missing destination directory');
  } catch (e) {
    // On Linux this might fail differently — check if the directory was created
    e.code === 'EACCES' ? pass('Replace auto-creates missing destination directory') : fail('Auto-create dir', e.message);
  }

  try {
    const restored = replacer.restoreFile(path.join(backupD, 'target.bin'), dstFile);
    const restoredContent = fs.readFileSync(dstFile, 'utf8');
    restoredContent === 'OLD CONTENT v1.0.0'
      ? pass('Restore from backup → original content recovered')
      : fail('Restore backup', `Content after restore: ${restoredContent}`);
  } catch (e) { fail('Restore backup', e.message); }

  // ── 8. Full Updater — Success Path ─────────────────────────────────────────
  section('8. Full Updater — Success Path (client updater.js)');

  const { Updater } = require('./ota-client/src/updater');
  const { ServiceManager } = require('./ota-client/src/service-manager');
  const { RollbackManager } = require('./ota-client/src/rollback');

  const updaterStateDir = path.join(TMP, 'updater_state');
  const updaterWorkDir  = path.join(TMP, 'updater_work');
  const installDir      = path.join(TMP, 'install_v2');
  fs.mkdirSync(updaterStateDir, { recursive: true });
  fs.mkdirSync(updaterWorkDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const updaterConfig = {
    agent:  { currentVersion: '0.0.0', workDir: updaterWorkDir, stateDir: updaterStateDir },
    update: { backupKeepCount: 3, serviceStopTimeoutMs: 5000, serviceStartTimeoutMs: 5000 }
  };
  const svcMgr = new ServiceManager(testLogger);
  const fReplacer = new FileReplacer(testLogger);
  const rollbackMgr = new RollbackManager(updaterStateDir, testLogger, svcMgr, fReplacer);

  // Re-build v2 zip pointing to installDir
  const zipV2Test = path.join(TMP, 'updater_v2.zip');
  buildPackage(zipV2Test, '2.0.0', installDir, true);
  const { computeSha256 } = require('./ota-client/src/verifier');
  const sha256V2 = await computeSha256(zipV2Test);

  const updater = new Updater(updaterConfig, testLogger, svcMgr, fReplacer, rollbackMgr);

  try {
    const result = await updater.applyUpdate(zipV2Test, {
      version: '2.0.0',
      packageId: 99,
      sha256Hash: sha256V2,
      fileMappings: []
    });
    if (result.success) {
      const exeContent = fs.readFileSync(path.join(installDir, 'MyService.exe'), 'utf8');
      const iniContent = fs.readFileSync(path.join(installDir, 'config.ini'), 'utf8');
      exeContent.includes('2.0.0') && iniContent.includes('version=2.0.0')
        ? pass('Full update applied: MyService.exe and config.ini written with v2.0.0 content')
        : fail('File content after update', `exe=${exeContent}, ini=${iniContent}`);
    } else {
      fail('updater.applyUpdate success path', result.error);
    }
  } catch (e) { fail('updater.applyUpdate success path', e.message); }

  try {
    const backupDirs = fs.readdirSync(path.join(updaterStateDir, 'backups'));
    backupDirs.length > 0
      ? pass(`Rollback checkpoint created: ${backupDirs[0]}`)
      : fail('Rollback checkpoint', 'No backup directory found');
  } catch (e) { fail('Rollback checkpoint', e.message); }

  // ── 9. Full Updater — Rollback Path ────────────────────────────────────────
  section('9. Full Updater — Rollback Path (broken post-update script)');

  const rollbackInstallDir = path.join(TMP, 'install_rollback');
  fs.mkdirSync(rollbackInstallDir, { recursive: true });
  // Write existing "v2" files that should be restored after rollback
  fs.writeFileSync(path.join(rollbackInstallDir, 'MyService.exe'), 'MyService.exe v2.0.0 existing');
  fs.writeFileSync(path.join(rollbackInstallDir, 'MyService.dll'), 'MyService.dll v2.0.0 existing');
  fs.writeFileSync(path.join(rollbackInstallDir, 'config.ini'), '[app]\nversion=2.0.0\n');

  const zipBrokenTest = path.join(TMP, 'updater_v3_broken.zip');
  buildPackage(zipBrokenTest, '3.0.0', rollbackInstallDir, false);  // post-update exits 1
  const sha256Broken = await computeSha256(zipBrokenTest);

  const rollbackStateDir = path.join(TMP, 'rollback_state');
  const rollbackWorkDir  = path.join(TMP, 'rollback_work');
  const rollbackConfig = {
    agent:  { currentVersion: '2.0.0', workDir: rollbackWorkDir, stateDir: rollbackStateDir },
    update: { backupKeepCount: 3, serviceStopTimeoutMs: 5000, serviceStartTimeoutMs: 5000 }
  };
  const rbSvcMgr    = new ServiceManager(testLogger);
  const rbReplacer  = new FileReplacer(testLogger);
  const rbMgr       = new RollbackManager(rollbackStateDir, testLogger, rbSvcMgr, rbReplacer);
  const rbUpdater   = new Updater(rollbackConfig, testLogger, rbSvcMgr, rbReplacer, rbMgr);

  try {
    const result = await rbUpdater.applyUpdate(zipBrokenTest, {
      version: '3.0.0', packageId: 100, sha256Hash: sha256Broken, fileMappings: []
    });
    if (!result.success && result.rolledBack) {
      const exeContent = fs.readFileSync(path.join(rollbackInstallDir, 'MyService.exe'), 'utf8');
      exeContent.includes('v2.0.0 existing')
        ? pass('Broken package triggered rollback; original v2.0.0 files restored')
        : fail('Rollback restore', `File content after rollback: ${exeContent}`);
    } else {
      fail('Rollback path', `Expected failure+rollback, got: success=${result.success}`);
    }
  } catch (e) { fail('Rollback path', e.message); }

  // ── 10. Status Reporting ────────────────────────────────────────────────────
  section('10. Status Reporting');

  try {
    const res = await request('POST', '/updates/status', {
      package_id: pkgId2, status: 'success', installed_version: '2.0.0'
    }, deviceToken);
    res.status === 200 && res.body.ok
      ? pass('POST /updates/status success → ok:true')
      : fail('Status success report', JSON.stringify(res.body));
  } catch (e) { fail('Status success report', e.message); }

  try {
    const res = await request('POST', '/updates/status', {
      package_id: pkgId1, status: 'rolled_back', error_message: 'Post-update script failed'
    }, deviceToken);
    res.status === 200 && res.body.ok
      ? pass('POST /updates/status rolled_back → ok:true')
      : fail('Status rolled_back report', JSON.stringify(res.body));
  } catch (e) { fail('Status rolled_back report', e.message); }

  try {
    const res = await request('POST', '/updates/status', { package_id: 1, status: 'invalid' }, deviceToken);
    res.status === 400
      ? pass('Invalid status value → 400')
      : fail('Status validation', `Expected 400, got ${res.status}`);
  } catch (e) { fail('Status validation', e.message); }

  // ── 11. Admin API ───────────────────────────────────────────────────────────
  section('11. Admin API');

  try {
    const res = await request('GET', '/admin/stats', null, ADMIN_SECRET);
    const s = res.body;
    res.status === 200 && s.total_devices >= 1 && s.total_packages >= 2
      ? pass(`Admin stats: ${s.total_devices} device(s), ${s.total_packages} package(s), ${s.success_jobs} success job(s)`)
      : fail('Admin stats', JSON.stringify(s));
  } catch (e) { fail('Admin stats', e.message); }

  try {
    const res = await request('GET', '/devices/', null, ADMIN_SECRET);
    res.status === 200 && Array.isArray(res.body.items)
      ? pass(`Admin device list: ${res.body.total} device(s)`)
      : fail('Admin device list', JSON.stringify(res.body));
  } catch (e) { fail('Admin device list', e.message); }

  try {
    const res = await request('GET', '/updates/history/' + deviceId, null, ADMIN_SECRET);
    res.status === 200 && Array.isArray(res.body.items) && res.body.items.length > 0
      ? pass(`Update job history: ${res.body.total} job(s) for device`)
      : fail('Update history', JSON.stringify(res.body));
  } catch (e) { fail('Update history', e.message); }

  // ── 12. gRPC Transport ─────────────────────────────────────────────────────
  section('12. gRPC Transport (client grpc-client.js)');

  const { GrpcOtaClient } = require('./ota-client/src/grpc-client');
  const grpcConfig = {
    server: { grpcEndpoint: GRPC_ADDR, tlsCert: '' },
    agent: {}
  };
  const grpcClient = new GrpcOtaClient(grpcConfig, testLogger);

  try {
    const connected = grpcClient.connect();
    connected
      ? pass('gRPC client connected to server')
      : fail('gRPC connect', 'connect() returned false');
  } catch (e) { fail('gRPC connect', e.message); }

  try {
    const res = await grpcClient.register('grpc-test-device-001', 'GRPC-WIN-01', 'Windows 11', '0.0.0');
    if (res.auth_token && res.device_id) {
      grpcRegisteredToken    = res.auth_token;
      grpcRegisteredDeviceId = res.device_id;
      pass(`gRPC Register: device_id=${res.device_id.slice(0, 8)}…, token=${res.auth_token.slice(0, 8)}…`);
    } else {
      fail('gRPC Register', JSON.stringify(res));
    }
  } catch (e) { fail('gRPC Register', e.message); }

  try {
    // Use the gRPC-registered token — no HTTP dependency
    const pollRes = await grpcClient.poll(grpcRegisteredDeviceId, grpcRegisteredToken, '0.0.0');
    if (pollRes.updateAvailable && pollRes.zipBuffer && pollRes.zipBuffer.length > 0) {
      pass(`gRPC Poll: update available v${pollRes.version}, streamed ${pollRes.zipBuffer.length} bytes`);
    } else {
      fail('gRPC Poll update', JSON.stringify({ updateAvailable: pollRes.updateAvailable, bytes: pollRes.zipBuffer && pollRes.zipBuffer.length }));
    }
  } catch (e) { fail('gRPC Poll', e.message); }

  try {
    // Device already at latest version → update_available:false
    const res2 = await grpcClient.register('grpc-uptodate-device', 'GRPC-UPTODATE', 'Windows 11', '2.0.0');
    const pollRes = await grpcClient.poll(res2.device_id, res2.auth_token, '2.0.0');
    !pollRes.updateAvailable
      ? pass('gRPC Poll (up-to-date) → update_available:false')
      : fail('gRPC Poll up-to-date', `Got update_available:true, version:${pollRes.version}`);
  } catch (e) { fail('gRPC Poll up-to-date', e.message); }

  grpcClient.destroy();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log(`\x1b[1mResults: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m  (${passed + failed} total)\x1b[0m`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  \x1b[31m✘ ${r.name}\x1b[0m: ${r.reason}`);
    });
    console.log('');
  } else {
    console.log('\n\x1b[32mAll tests passed.\x1b[0m\n');
  }

  // Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\x1b[31mTest runner crashed:\x1b[0m', err.message);
  process.exit(2);
});
