// Detects a model stuck in a reasoning loop (the same sentence coming back again and again), from the
// streamed reasoning text. Ordinary reasoning repeats short lines now and then ("Need to cite S3."), so
// the guard only fires on sustained repetition, and only after a fair amount of text.

export interface LoopGuardOptions {
  minChars: number; // judge nothing before this much reasoning text
  minLen: number; // ignore sentences shorter than this
  run: number; // the same sentence this many times in a row = loop
  window: number; // or: within the last `window` sentences…
  maxDistinct: number; // …no more than this many distinct ones = loop
}

const DEFAULTS: LoopGuardOptions = { minChars: 3000, minLen: 30, run: 6, window: 16, maxDistinct: 2 };

export class LoopGuard {
  private tail = "";
  private recent: string[] = [];
  private chars = 0;
  private readonly o: LoopGuardOptions;

  constructor(opts: Partial<LoopGuardOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
  }

  /** Feed the next chunk of reasoning; returns true once the stream looks stuck. */
  push(text: string): boolean {
    this.chars += text.length;
    this.tail += text;
    const parts = this.tail.split(/(?<=[.!?\n])/);
    this.tail = parts.pop() ?? "";
    for (const p of parts) {
      const key = p.trim().toLowerCase().replace(/\s+/g, " ");
      if (key.length < this.o.minLen) continue;
      this.recent.push(key);
      if (this.recent.length > this.o.window) this.recent.shift();
    }
    if (this.chars < this.o.minChars) return false;
    const n = this.recent.length;
    if (n >= this.o.run && this.recent.slice(-this.o.run).every((s) => s === this.recent[n - 1])) return true;
    return n >= this.o.window && new Set(this.recent).size <= this.o.maxDistinct;
  }
}
