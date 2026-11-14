const BREATHING_MODES = ["extended", "equal"];
const EQUAL_PACES = [3, 4, 5];

function breathingTiming(options = {}) {
  if (options.mode === "extended") return { inhaleSeconds: 4, exhaleSeconds: 6 };
  // Records and clients predating modes used equal inhalation and exhalation.
  const seconds = EQUAL_PACES.includes(options.pace) ? options.pace : 4;
  return { inhaleSeconds: seconds, exhaleSeconds: seconds };
}

module.exports = { BREATHING_MODES, EQUAL_PACES, breathingTiming };
