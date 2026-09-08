// Shared rate-limit helper. Each endpoint gets its own independent counter
// by calling createRateLimiter() once at module load and reusing it.
function createRateLimiter(maxPerHour) {
  const hits = new Map();
  return function rateLimited(key) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const record = hits.get(key) || [];
    const recent = record.filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > maxPerHour;
  };
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

module.exports = { createRateLimiter, getClientIp };
