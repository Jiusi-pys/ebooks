/**
 * Monotonic fence for UI requests whose responses may arrive out of order.
 * Only the most recently started request is allowed to update component state.
 */
export function createLatestRequestGate() {
  let epoch = 0;
  return {
    begin(): number {
      epoch += 1;
      return epoch;
    },
    isCurrent(ticket: number): boolean {
      return ticket === epoch;
    },
    invalidate(): void {
      epoch += 1;
    },
  };
}
