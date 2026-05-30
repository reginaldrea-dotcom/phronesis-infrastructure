// Anthropic fetch with 429 retry/backoff.

export class AnthropicRateLimitError extends Error {
  constructor() { super("Anthropic rate limit exceeded"); this.name = "AnthropicRateLimitError"; }
}

export async function fetchAnthropicWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    if (attempt === maxRetries) throw new AnthropicRateLimitError();
    const retryAfter = response.headers.get("retry-after");
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }
  throw new AnthropicRateLimitError();
}
