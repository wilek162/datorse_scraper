'use strict';

const path = require('path');
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const baseFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
);

const consoleFormat = format.combine(
  baseFormat,
  format.colorize(),
  format.printf(({ timestamp, level, message, sourceId, ...meta }) => {
    const src = sourceId ? `[${sourceId}] ` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level}: ${src}${message}${extra}`;
  }),
);

const fileFormat = format.combine(
  baseFormat,
  format.json(),
);

const logger = createLogger({
  level: LOG_LEVEL,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'datorsc-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: fileFormat,
      zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'datorsc-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      format: fileFormat,
      zippedArchive: true,
    }),
  ],
});

/**
 * Returns a child logger bound to a specific source ID.
 * All logs from that source will include sourceId for easy filtering.
 */
logger.forSource = (sourceId) => logger.child({ sourceId });

module.exports = logger;
