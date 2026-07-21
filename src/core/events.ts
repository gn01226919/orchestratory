import { EventEmitter } from "node:events";
import type { RunEvent } from "../types.ts";
import { safeSummary } from "../security/redact.ts";
import type { LocalStore } from "./store.ts";

export class RunEvents {
  readonly #emitter = new EventEmitter();
  readonly #store: LocalStore;

  constructor(store: LocalStore) {
    this.#store = store;
    this.#emitter.setMaxListeners(100);
  }

  emit(event: Omit<RunEvent, "at"> & { at?: string }): RunEvent {
    const safeEvent: RunEvent = {
      ...event,
      at: event.at ?? new Date().toISOString(),
      summary: safeSummary(event.summary),
    };
    safeEvent.id = this.#store.appendEvent(safeEvent);
    this.#emitter.emit(event.runId, safeEvent);
    return safeEvent;
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.#emitter.on(runId, listener);
    return () => this.#emitter.off(runId, listener);
  }
}
