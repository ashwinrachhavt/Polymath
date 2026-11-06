type ModelCallOptions = {
  maxOutputTokens?: number;
  [key: string]: unknown;
};

/**
 * Keep credit-limited OpenAI-compatible providers from receiving an output
 * request larger than the account can afford. Eve's durable runtime supplies
 * its catalog maximum to the AI SDK call, so this adapter clamps both streaming
 * and non-streaming calls at the model boundary.
 */
export function withMaxOutputTokens<T extends object>(model: T, limit: number): T {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("max output tokens must be a positive integer");
  }

  return new Proxy(model, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if ((property === "doGenerate" || property === "doStream") && typeof method === "function") {
        return (options: ModelCallOptions) => {
          const requested = options.maxOutputTokens;
          return Reflect.apply(method, target, [
            {
              ...options,
              maxOutputTokens: typeof requested === "number" ? Math.min(requested, limit) : limit,
            },
          ]);
        };
      }
      return method;
    },
  });
}
