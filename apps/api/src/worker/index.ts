import type { Chain } from "../chain";
import type { Db } from "../db";
import { Indexer } from "./indexer";
import { Reconciler } from "./reconciler";
import { Tracker } from "./tracker";
import { Webhooks } from "./webhooks";

export class Worker {
  readonly reconciler: Reconciler;
  readonly indexer: Indexer;
  readonly tracker: Tracker;
  readonly webhooks: Webhooks;
  private ticks = 0;
  /** Last failure per stage, kept until that stage next succeeds (stages run at different rates). */
  private readonly stageErrors = new Map<string, { message: string; at: string }>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly db: Db,
    chain: Chain,
    private readonly options: { workerId: string; tickMs: number; indexEveryTicks?: number },
  ) {
    this.reconciler = new Reconciler(db, chain);
    this.indexer = new Indexer(db, chain, this.reconciler);
    this.tracker = new Tracker(db, chain, this.reconciler, this.indexer, options.workerId);
    this.webhooks = new Webhooks(db);
  }

  /** One pass of every loop. Each stage is independent: a failing stage does not block others. */
  async tick(): Promise<void> {
    this.ticks += 1;
    const stages: [string, () => Promise<unknown>][] = [
      ["tracker", () => this.tracker.tick()],
      ["expiry", () => this.tracker.expireUnsigned()],
      ["webhooks", () => this.webhooks.deliver()],
    ];
    if ((this.ticks - 1) % (this.options.indexEveryTicks ?? 3) === 0) {
      stages.push(["indexer", () => this.indexer.syncAll()]);
    }
    for (const [name, stage] of stages) {
      try {
        await stage();
        this.stageErrors.delete(name);
      } catch (error) {
        this.stageErrors.set(name, { message: (error as Error).message, at: new Date().toISOString() });
      }
    }
    const errors = Object.fromEntries(this.stageErrors);
    await this.db`
      INSERT INTO worker_heartbeats (worker_id, seen_at, details)
      VALUES (${this.options.workerId}, now(), ${{ ticks: this.ticks, errors }})
      ON CONFLICT (worker_id) DO UPDATE SET seen_at = now(), details = EXCLUDED.details`;
  }

  start(): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (error) {
        console.error("worker tick failed", error);
      }
      if (this.running) this.timer = setTimeout(loop, this.options.tickMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
