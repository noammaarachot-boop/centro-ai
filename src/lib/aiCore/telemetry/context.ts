import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who and what an AI call is for, carried alongside the call itself.
 *
 * The problem this solves: a cost table is only useful if every row says
 * which tenant to bill and which feature to blame, but the functions that
 * call the provider mostly do not know either. classifyYesNoReply receives a
 * question and a reply — no organization, no request. Threading those through
 * twelve signatures (and every caller of every one of them) would be a large,
 * invasive change whose only purpose is bookkeeping, and every new call site
 * would be one forgotten parameter away from an unattributed row.
 *
 * So the context travels out of band. A boundary that DOES know the tenant —
 * the WhatsApp webhook, a server action, the assistant route — declares it
 * once, and every AI call underneath inherits it, however deep. Each AI
 * function then names only the one thing it alone knows: what it is doing.
 *
 * AsyncLocalStorage propagates across awaits, so this survives the provider
 * SDK's own internals without any cooperation from them.
 */
export interface AiCallContext {
  organizationId?: string | null;
  collectionRequestId?: string | null;
  conversationId?: string | null;
  documentId?: string | null;
  /** What the product is doing, e.g. "document.vision_classify". */
  operation?: string;
  /**
   * Attempts made inside THIS scope, owned by the middleware.
   *
   * Mutable on purpose: the provider SDK retries by calling the model again,
   * and the middleware is the only thing positioned to see each attempt. One
   * scope wraps exactly one logical call, so this counts that call's retries
   * rather than accumulating across unrelated ones.
   */
  attemptCounter?: { count: number };
}

const storage = new AsyncLocalStorage<AiCallContext>();

/**
 * Declares the tenant (and any known identifiers) for everything inside.
 *
 * Used at boundaries. Merges with any surrounding context rather than
 * replacing it, so an inner scope can add a document id without discarding
 * the organization an outer scope established.
 */
export function withAiContext<T>(context: AiCallContext, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...stripUndefined(context) }, fn);
}

/**
 * Declares which operation is running, and opens a fresh attempt counter.
 *
 * Wraps exactly ONE provider call. Two calls in the same function get two
 * scopes with two names, because "how much did understanding a turn cost"
 * and "how much did writing the reply cost" are different answers and a
 * single label would hide one behind the other.
 */
export function withAiOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  context: Omit<AiCallContext, "operation" | "attemptCounter"> = {}
): Promise<T> {
  const parent = storage.getStore() ?? {};
  return storage.run(
    { ...parent, ...stripUndefined(context), operation, attemptCounter: { count: 0 } },
    fn
  );
}

export function getAiCallContext(): AiCallContext | undefined {
  return storage.getStore();
}

/**
 * An explicitly undefined field must not erase an inherited one.
 *
 * Callers routinely pass `{ conversationId: maybeUndefined }`; without this,
 * spreading it would blank out a conversation id the boundary had already
 * established. Null is left alone — that is a caller deliberately saying
 * "there is none".
 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
