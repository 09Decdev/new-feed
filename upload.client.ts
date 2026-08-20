/**
 * Upload an image to upload-service via the gateway and return the fileId.
 * POST /upload-service/files/upload (multipart, field 'file').
 * The File record is created with status PENDING (async optimization via Kafka);
 * content-service's check-batch does not filter by status, so PENDING is accepted.
 */

export async function uploadImage(
  gatewayUrl: string,
  token: string,
  args: { bytes: Uint8Array; filename: string; mimeType: string },
): Promise<string> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/upload-service/files/upload`;
  const form = new FormData();
  const blob = new Blob([args.bytes], { type: args.mimeType });
  form.append('file', blob, args.filename);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `upload image failed: HTTP ${res.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  const data = body?.data ?? body;
  const fileId = data?.id;
  if (!fileId) {
    throw new Error(`upload image: no id in response — ${JSON.stringify(body)}`);
  }
  return fileId;
}
