const config = require('../config');

const buckets = new Map();

function check(ip) {
  const now = Date.now();
  let bucket = buckets.get(ip) || { count: 0, resetAt: now + config.VIDEO_RATE_LIMIT_WINDOW_MS };
  if (now >= bucket.resetAt) bucket = { count: 0, resetAt: now + config.VIDEO_RATE_LIMIT_WINDOW_MS };
  bucket.count++;
  buckets.set(ip, bucket);
  return bucket.count <= config.VIDEO_RATE_LIMIT_MAX;
}

module.exports = { check };
