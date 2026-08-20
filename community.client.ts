function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Downstream responses may be wrapped ({success,data,...}) or raw; unwrap defensively.
function unwrap(body: any): any {
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) return body.data;
  return body;
}

/** GET /user-community/community-member/approved — list of community IDs the user is a member of. */
export async function listMyCommunities(
  gatewayUrl: string,
  token: string,
): Promise<string[]> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/user-community/community-member/approved`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = parseJson(await res.text());
  if (!res.ok) {
    throw new Error(
      `list communities failed: HTTP ${res.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  const data = unwrap(body);
  return Array.isArray(data) ? data : Array.isArray(body) ? body : [];
}

export interface MemberPermission {
  id?: string; // communityMemberId
  role?: string;
  communityPermission?: { permissionName: string }[];
}

/** GET /user-community/community-member/community/:id — the caller's membership + permissions. */
export async function getMyMemberPermission(
  gatewayUrl: string,
  token: string,
  communityId: string,
): Promise<MemberPermission> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/user-community/community-member/community/${communityId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = parseJson(await res.text());
  if (!res.ok) {
    throw new Error(
      `get member permission failed: HTTP ${res.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return unwrap(body) ?? {};
}

export function hasPostPermission(p: MemberPermission | null | undefined): boolean {
  if (!p) return false;
  if (p.role === 'OWNER') return true;
  return (p.communityPermission ?? []).some((cp) => cp.permissionName === 'POST_CONTENT');
}

/** GET /user-community/community/:id — community details (name, ownerId, …). */
export async function getCommunityDetail(
  gatewayUrl: string,
  token: string,
  communityId: string,
): Promise<{ name?: string; ownerId?: string; totalMember?: number; [k: string]: any }> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/user-community/community/${communityId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = parseJson(await res.text());
  if (!res.ok) {
    throw new Error(
      `get community failed: HTTP ${res.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return unwrap(body) ?? {};
}
