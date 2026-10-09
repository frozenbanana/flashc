// SM-2 scheduler with Anki-style learning steps.
//
// Card states:
//   step >= 0   -> learning card (interval 0). Steps: 1min, 10min.
//   step === -1 -> review card (graduated). interval in days.
//
// Grading: 0 = Again, 1 = Hard, 2 = Good, 3 = Easy.

export const LEARNING_STEPS_MS = [1 * 60_000, 10 * 60_000];
export const NEW_INTERVAL_DAYS = 1;   // graduating interval (Good)
export const EASY_INTERVAL_DAYS = 4;  // Easy from learning

const MIN_EASE = 1.3;
const DAY_MS = 86_400_000;

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}

export function isLearning(card) {
  return card.step >= 0;
}

export function isNew(card) {
  return card.reps === 0 && card.step === 0 && card.interval === 0;
}

/**
 * Compute the next scheduling state.
 * Returns { due, interval, ease, step, lapses }.
 */
export function schedule(card, grade, now = Date.now()) {
  let { ease, step, interval, lapses } = card;

  if (isLearning(card)) {
    if (grade === 0) {
      // Again: back to first step, short delay
      step = 0;
      return { due: now + LEARNING_STEPS_MS[0], interval: 0, ease, step, lapses };
    }
    if (grade === 3) {
      // Easy: graduate immediately with easy interval
      return { due: now + EASY_INTERVAL_DAYS * DAY_MS, interval: EASY_INTERVAL_DAYS, ease, step: -1, lapses };
    }
    if (step < LEARNING_STEPS_MS.length - 1) {
      // advance to next learning step
      step = step + 1;
      return { due: now + LEARNING_STEPS_MS[step], interval: 0, ease, step, lapses };
    }
    // graduate
    const days = grade === 1 ? Math.max(NEW_INTERVAL_DAYS - 1, 1) : NEW_INTERVAL_DAYS;
    return { due: now + days * DAY_MS, interval: days, ease, step: -1, lapses };
  }

  // --- review card ---
  if (grade === 0) {
    lapses = lapses + 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
    // relearn: reset to learning queue, first step
    step = 0;
    return { due: now + LEARNING_STEPS_MS[0], interval: 0, ease, step, lapses };
  }

  const delayFactor = { 1: 1.2, 2: ease, 3: ease * 1.3 }[grade];
  let days = interval * delayFactor;
  if (grade === 1) days = Math.min(days, interval * 1.2 + 1); // cap hard
  if (grade === 2) ease = Math.max(MIN_EASE, ease + 0);         // good: ease unchanged
  if (grade === 3) ease = ease + 0.15;

  days = Math.max(1, Math.round(days * 10) / 10);
  return { due: now + days * DAY_MS, interval: days, ease: Math.max(MIN_EASE, ease), step: -1, lapses };
}

/** Preview the interval labels for the four answer buttons (Anki-style). */
export function previewLabels(card) {
  const now = Date.now();
  const fmt = (state) => {
    if (state.step >= 0) {
      const ms = state.due - now;
      if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
      return `${Math.round(ms / 60_000)}m`;
    }
    const d = state.due - now;
    if (d < DAY_MS) return '<1d';
    if (d < 2 * DAY_MS) return '1d';
    return `${Math.round(d / DAY_MS)}d`;
  };
  return [0, 1, 2, 3].map(g => fmt(schedule(card, g, now)));
}
