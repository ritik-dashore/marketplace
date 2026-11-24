export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'market-place',
    password: process.env.DB_PASSWORD || 'market-place_password',
    database: process.env.DB_NAME || 'market-place',
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  marketplaceUrl: process.env.MARKETPLACE_URL || 'http://host.docker.internal:4000',
  pickLockTtlSeconds: parseInt(process.env.PICK_LOCK_TTL_SECONDS || '900', 10),
};
