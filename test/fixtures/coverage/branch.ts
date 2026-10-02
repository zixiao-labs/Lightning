export interface Input {
  value: number;
}

export function classify(input: Input): string {
  if (input.value > 0) {
    return "positive";
  }
  return "other";
}
