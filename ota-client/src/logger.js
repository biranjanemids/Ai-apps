'use strict';
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const fs = require('fs');
const path = require('path');

let logger;

function getLogger(logFile) {
  if (logger) return logger;

  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const transportList = [
    new transports.DailyRotateFile({
      filename: logFile.replace('.log', '-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '5d',
      format: format.combine(format.timestamp(), format.json())
    })
  ];

  // Console output when running interactively
  if (process.stdout.isTTY || process.env.OTA_CONSOLE_LOG === '1') {
    transportList.push(new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'HH:mm:ss' }),
        format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
      )
    }));
  }

  logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: transportList,
    exitOnError: false
  });

  return logger;
}

module.exports = { getLogger };
