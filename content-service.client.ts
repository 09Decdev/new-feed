/**
 * Wrapper for POST /content-service/post.
 * Creates a regular (non-premium) post on behalf of the token's user.
 */

export interface CreatePostInput {
  communityId: string;
  content: string;
  layoutType: string;
  fileIds?: string[];
}

export interface CreatePostError extends Error {
  status?: number;
  body?: any;
}

export async function createPost(
  baseUrl: string,
  token: string,
  input: CreatePostInput,
): Promise<any> {
  const url = `${baseUrl.replace(/\/$/, '')}/content-service/post`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  if (!res.ok) {
    const err = new Error(
      `Create post failed: HTTP ${res.status} ${res.statusText} — ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    ) as CreatePostError;
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/** Classify a thrown CreatePostError into a short reason code for logging. */
export function describeError(err: any): string {
  const status = err?.status;
  const body = err?.body;
  const errorField = body?.error;
  const isProfanity =
    status === 400 &&
    (errorField === 'INAPPROPRIATE_CONTENT' ||
      errorField === 40001 ||
      errorField === 'POST_PROFANITY' ||
      body?.code === '40001' ||
      Array.isArray(body?.words));
  if (isProfanity) {
    const words =
      Array.isArray(body?.words) && body.words.length ? body.words.join(', ') : '?';
    return `PROFANITY_REJECTED (words: ${words})`;
  }
  if (status === 400) return `BAD_REQUEST (${errorField || body?.message || '?'})`;
  if (status === 401) return 'UNAUTHORIZED (token invalid?)';
  if (status === 403) return 'FORBIDDEN (no post permission / not a member?)';
  if (status && status >= 500) return `SERVER_ERROR (${status})`;
  return err?.message || 'UNKNOWN';
}
