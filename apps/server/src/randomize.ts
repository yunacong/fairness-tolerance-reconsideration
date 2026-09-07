import { createHash } from "node:crypto";

export function deterministicOrder<T extends { view_id: string }>(items: T[], sessionId: string): T[] {
  const seed = createHash("sha256").update(sessionId).digest().readUInt32LE(0);
  let state = seed || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}
