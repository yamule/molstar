// Helpers to run the generator-based pipelines (surface generation, texturing) synchronously or with
// asynchronous progress callbacks (so the browser UI can update between stages).

/** Drive a generator to completion synchronously and return its return value. */
export function runSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/**
 * Drive a generator to completion, awaiting `onProgress(message)` at every yield.
 * @param {Generator} gen
 * @param {(message: string) => (void|Promise<void>)} [onProgress]
 */
export async function runAsync(gen, onProgress) {
  let r = gen.next();
  while (!r.done) {
    if (onProgress) await onProgress(r.value);
    r = gen.next();
  }
  return r.value;
}
