'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

class HttpOtaClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.baseUrl = config.server.httpUrl;
  }

  _getAgent() {
    if (this.baseUrl.startsWith('https')) {
      const opts = { rejectUnauthorized: false };
      if (this.config.server.tlsCert && fs.existsSync(this.config.server.tlsCert)) {
        opts.ca = fs.readFileSync(this.config.server.tlsCert);
        opts.rejectUnauthorized = true;
      }
      return new https.Agent(opts);
    }
    return new http.Agent();
  }

  _request(method, urlPath, body, authToken, binary = false) {
    return new Promise((resolve, reject) => {
      const fullUrl = new URL(urlPath, this.baseUrl);
      const isHttps = fullUrl.protocol === 'https:';
      const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;

      const options = {
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
          ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {})
        },
        rejectUnauthorized: false,
        timeout: this.config.server.timeoutMs || 30000
      };

      if (this.config.server.tlsCert && fs.existsSync(this.config.server.tlsCert)) {
        options.ca = fs.readFileSync(this.config.server.tlsCert);
        options.rejectUnauthorized = true;
      }

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        if (binary) {
          const bufs = [];
          res.on('data', d => bufs.push(d));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
        } else {
          let data = '';
          res.on('data', d => (data += d));
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
            } catch {
              resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
            }
          });
        }
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  async register(deviceId, hostname, osVersion, currentVersion) {
    const res = await this._request('POST', '/devices/register', {
      device_id: deviceId,
      hostname,
      os_version: osVersion,
      current_version: currentVersion
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`Registration failed: ${res.statusCode}`);
    }
    return res.body;
  }

  async poll(deviceId, authToken, currentVersion) {
    const res = await this._request(
      'POST',
      '/updates/poll',
      { device_id: deviceId, current_version: currentVersion },
      authToken,
      true
    );

    if (res.statusCode === 204) return { updateAvailable: false };
    if (res.statusCode !== 200) throw new Error(`Poll failed: ${res.statusCode}`);

    const h = res.headers;
    const mappingsRaw = h['x-file-mappings'];
    return {
      updateAvailable: true,
      version: h['x-package-version'],
      packageId: parseInt(h['x-package-id']),
      packageName: h['x-package-name'],
      sha256Hash: h['x-sha256'],
      releaseNotes: h['x-release-notes'] || '',
      fileMappings: mappingsRaw ? JSON.parse(mappingsRaw) : [],
      zipBuffer: res.body
    };
  }

  async reportStatus(deviceId, authToken, packageId, status, errorMessage, installedVersion) {
    await this._request('POST', '/updates/status', {
      device_id: deviceId,
      package_id: packageId,
      status,
      error_message: errorMessage || null,
      installed_version: installedVersion || null
    }, authToken);
  }
}

module.exports = { HttpOtaClient };
