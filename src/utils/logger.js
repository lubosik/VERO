import winston from 'winston'

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
      return `${timestamp} [${level.toUpperCase()}] ${message}${suffix}`
    })
  ),
  transports: [new winston.transports.Console()]
})
