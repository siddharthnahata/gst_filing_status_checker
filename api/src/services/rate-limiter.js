/**
 * Serial rate limiter for GST-portal calls.
 *
 * The GST F5 WAF throttles rapid automated requests from a single IP (a fresh
 * cloud IP especially) — a burst of filing-status lookups gets the IP a
 * "system error, try after sometime" / decoy "invalid password" cooldown. This
 * runs GST-bound work ONE AT A TIME with a minimum gap between starts, so no
 * client can burst the portal no matter how fast it fires requests.
 *
 * Gap is configurable: GST_MIN_GAP_MS (default 1200ms).
 */
const MIN_GAP_MS = Number.parseInt(process.env.GST_MIN_GAP_MS || '', 10) || 1200;

let chain = Promise.resolve();
let lastStart = 0;

/**
 * Queue an async task. Tasks run sequentially in call order; each waits until
 * at least MIN_GAP_MS has passed since the previous task started.
 */
function schedule(task) {
  const run = async () => {
    const since = Date.now() - lastStart;
    if (since < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - since));
    }
    lastStart = Date.now();
    return task();
  };
  // Run after whatever is already queued, regardless of its success/failure,
  // and don't let a rejection break the chain for later tasks.
  const result = chain.then(run, run);
  chain = result.then(() => {}, () => {});
  return result;
}

module.exports = { schedule, MIN_GAP_MS };
