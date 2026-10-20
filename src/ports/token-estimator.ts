export interface TokenEstimator {
  estimate(text: string): number;
}
