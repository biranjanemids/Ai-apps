'use strict';
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'ota.proto');
const CHUNK_SIZE = 256 * 1024;

function loadProto() {
  const pkg = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  return grpc.loadPackageDefinition(pkg).ota;
}

function buildCredentials(tlsCertPath) {
  if (tlsCertPath && fs.existsSync(tlsCertPath)) {
    const cert = fs.readFileSync(tlsCertPath);
    return grpc.credentials.createSsl(cert, null, null, {
      checkServerIdentity: () => undefined
    });
  }
  return grpc.credentials.createInsecure();
}

class GrpcOtaClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.stub = null;
  }

  connect() {
    try {
      const proto = loadProto();
      const creds = buildCredentials(this.config.server.tlsCert);
      this.stub = new proto.OTAService(this.config.server.grpcEndpoint, creds, {
        'grpc.keepalive_time_ms': 30000,
        'grpc.keepalive_timeout_ms': 10000
      });
      return true;
    } catch (err) {
      this.logger.error(`gRPC connect failed: ${err.message}`);
      return false;
    }
  }

  async register(deviceId, hostname, osVersion, currentVersion) {
    return new Promise((resolve, reject) => {
      this.stub.Register(
        { device_id: deviceId, hostname, os_version: osVersion, current_version: currentVersion },
        (err, response) => {
          if (err) return reject(err);
          resolve(response);
        }
      );
    });
  }

  async poll(deviceId, authToken, currentVersion, installedServices = []) {
    return new Promise((resolve, reject) => {
      const call = this.stub.Poll({
        device_id: deviceId,
        auth_token: authToken,
        current_version: currentVersion,
        installed_services: installedServices
      });

      const chunks = [];
      let meta = null;

      call.on('data', (msg) => {
        if (!msg.update_available) {
          resolve({ updateAvailable: false });
          return;
        }
        if (!meta) {
          meta = {
            version: msg.version,
            packageId: msg.package_id,
            packageName: msg.package_name,
            sha256Hash: msg.sha256_hash,
            releaseNotes: msg.release_notes,
            fileMappings: msg.file_mappings || []
          };
        }
        if (msg.chunk && msg.chunk.length) {
          chunks.push(Buffer.from(msg.chunk));
        }
      });

      call.on('end', () => {
        if (!meta) {
          resolve({ updateAvailable: false });
          return;
        }
        resolve({
          updateAvailable: true,
          ...meta,
          zipBuffer: Buffer.concat(chunks)
        });
      });

      call.on('error', reject);
    });
  }

  async reportStatus(deviceId, authToken, packageId, status, errorMessage, installedVersion) {
    return new Promise((resolve, reject) => {
      this.stub.ReportStatus(
        {
          device_id: deviceId,
          auth_token: authToken,
          package_id: packageId,
          status,
          error_message: errorMessage || '',
          installed_version: installedVersion || ''
        },
        (err, response) => {
          if (err) return reject(err);
          resolve(response);
        }
      );
    });
  }

  destroy() {
    if (this.stub) grpc.closeClient(this.stub);
  }
}

module.exports = { GrpcOtaClient };
