import type { TokenEstimator } from '../../ports/token-estimator';

const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD = 4;

export const heuristicTokenEstimator: TokenEstimator = {
  estimate: (text) => Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD,
};
