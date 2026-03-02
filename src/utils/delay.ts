/**
 * Sleep for a random duration between min and max milliseconds.
 * Used to simulate human-like pauses between actions.
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short pause simulating human reaction time (0.8 – 2s). */
export const humanPause = () => randomDelay(800, 2000);

/** Medium pause between distinct steps (2 – 5s). */
export const stepPause = () => randomDelay(2000, 5000);

/** Longer pause between bot creations (5 – 15s). */
export const botGapPause = () => randomDelay(5000, 15000);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
