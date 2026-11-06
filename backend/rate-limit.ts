/** Per-process transport guard. Durable domain write limits also live in Arkiv. */
export function requestLimiter(max = 120, windowMs = 60_000) {
  const buckets = new Map<string, { until: number; count: number }>();
  return (key: string, now = Date.now()) => {
    for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
    const bucket = buckets.get(key);
    if (bucket) return ++bucket.count <= max;
    if (buckets.size >= 10_000) return false;
    buckets.set(key, { until: now + windowMs, count: 1 });
    return true;
  };
}
