import { AsyncLocalStorage } from "node:async_hooks";
import type { MemmyConfig } from "../config/index.js";
import type {
  LlmClient,
  LlmCompletionOptions,
  LlmMessage,
  ModelStatus
} from "./types.js";

export type MemoryModelRole = "summary" | "evolution";

export interface MemoryModelTaskContext {
  config: MemmyConfig;
  summary: LlmClient;
  evolution: LlmClient;
}

export class MemoryModelTaskRouter {
  private readonly storage = new AsyncLocalStorage<MemoryModelTaskContext>();

  constructor(
    private readonly resolveContext: () => MemoryModelTaskContext
  ) {}

  client(role: MemoryModelRole): LlmClient {
    return new TaskRoutedLlmClient(role, this);
  }

  currentOrResolve(): MemoryModelTaskContext {
    return this.storage.getStore() ?? this.resolveContext();
  }

  run<T>(operation: () => T): T {
    if (this.storage.getStore()) return operation();
    return this.storage.run(this.resolveContext(), operation);
  }
}

class TaskRoutedLlmClient implements LlmClient {
  constructor(
    private readonly role: MemoryModelRole,
    private readonly router: MemoryModelTaskRouter
  ) {}

  get config() {
    return this.delegate().config;
  }

  isConfigured(): boolean {
    return this.delegate().isConfigured();
  }

  complete(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<string> {
    return this.router.run(() => this.delegate().complete(messages, options));
  }

  completeJson<T extends Record<string, unknown>>(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<T> {
    return this.router.run(() => this.delegate().completeJson<T>(messages, options));
  }

  status(): ModelStatus {
    return this.delegate().status();
  }

  private delegate(): LlmClient {
    return this.router.currentOrResolve()[this.role];
  }
}
