/**
 * Ids of requests (§8.1 of the specification) for several clients of one engine, such as the Apps and the grids of
 * an MCP server or the webviews of an editor. Each client chooses ids of its own, which the engine would mix up (a `cancel` of one
 * client's request would stop another's): the requests of each client get ids that are unique in the engine, and
 * the answers get the client's ids back.
 */

type Json = Record<string, unknown>;

/** What the clients share: the engine's `handle`, as `DuckDBEngine` has it. */
export interface Handler {
  handle(message: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class RequestIds {
  private next = 1;

  constructor(private readonly engine: Handler) {}

  /** A client of the engine whose requests keep their ids apart from those of the others. */
  client(): Handler {
    // The engine's ids of this client's requests in flight, by the client's ids.
    const running = new Map<number, number>();
    return {
      handle: async (message, options) => {
        // A message without a valid id is the engine's to refuse, as it is (§8.1).
        if (!isObject(message) || !isId(message.id)) return this.engine.handle(message, options);
        const own = message.id;
        const id = this.next++;
        const sent: Json = { ...message, id };
        if (message.op === "cancel" && isId(message.request)) {
          // A request that is not running any more is cancelled under an id that no request has.
          sent.request = running.get(message.request) ?? this.next++;
        } else {
          running.set(own, id);
        }
        try {
          const answer = await this.engine.handle(sent, options);
          return isObject(answer) && answer.id === id ? { ...answer, id: own } : answer;
        } finally {
          if (running.get(own) === id) running.delete(own);
        }
      },
    };
  }
}
