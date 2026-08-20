import { validateLlmBaseUrlStatic } from './safe-fetch';

/**
 * Rewrite a scraped article via an Anthropic-compatible Messages API.
 * Goals: (1) paraphrase (not verbatim) — lower copyright risk;
 * (2) avoid EVERY word in content-service's profanity banned list so the post passes the
 * filter (regex matches tokens like "đánh", "kiếm", "rượu", "chết"... even inside common
 * compounds such as "đánh giá", "kiếm tiền"). The LLM is given the full banned list and
 * must rephrase around every one of them.
 *
 * Default endpoint is an Anthropic-protocol relay (ai-box.vn) with model deepseek-v4-flash[1m].
 * Native fetch, zero deps. Sync this list if content-service's profanity.helper.ts changes.
 */

// Mirror of content-service/src/core/helper/profanity.helper.ts vietnameseBadWords.
const BANNED_WORDS = [
  'đjt', 'djt', 'đ1t', 'd1t', 'đ!t', 'd!t', 'đt', 'đ.ị.t', 'đ_ị_t', 'd!~t',
  'địt cụ', 'địt mẹ', 'đjt m3', 'đ!t c0n', 'địt cha', 'địt tổ', 'l0n', 'l0^n',
  'ln', 'l.ồ.n', 'l_ồ_n', 'lờ', 'lzz', 'l0zz', 'lừn', 'nứng lồn', 'c@c', 'c.ặ.c',
  'kặk', 'kặc', 'cặk', 'c4c', 'bồi', 'bu0i', 'bu0^i', 'b.u.ồ.i', 'pùi', 'nứng cặc',
  'đ*', 'đ!', 'đ~', 'đ.ĩ', 'đ1', 'đỷ', 'đỹ', 'd*', 'ph0', 'ph0`', 'ph.ò', 'con đĩ',
  'nứng', 'kích dục', 'sex', 'chat sex', 'khiêu dâm', 'hiếp dâm', 'mây mưa',
  'hở hang', 'quan hệ', 'gái gọi', 'khoe hàng',
  'đụ má', 'đụ mẹ', 'đụ móa', 'đụ đĩ mẹ', 'đĩ chó', 'bắc kỳ', 'nam kỳ',
  'bạo loạn', 'khủng bố', 'bắt nạt', 'đánh', 'giết', 'giết người', 'chết',
  'tự tử', 'xử tử', 'chặt đầu', 'chặt xác', 'tra tấn', 'hành hạ', 'đâm', 'chém',
  'bắt cóc', 'máu me', 'tai nạn',
  'vay vốn', 'vay tiền', 'giải ngân', 'lãi suất', 'tiền ảo', 'làm giàu nhanh',
  'việc nhẹ lương cao', 'đa cấp', 'hoa hồng', 'nợ xấu', 'crack', 'hack', 'lậu',
  'nike', 'adidas', 'chanel', 'gucci', 'apple', 'dior',
  'thuốc phiện', 'cần sa', 'cao côca', 'heroin', 'cocaine', 'methamphetamine',
  'ma túy đá', 'amphetamine', 'ketamine', 'fentanyl', 'mdma', 'thuốc lắc',
  'xlr-11', 'cỏ mỹ', 'ma túy', 'bóng cười', 'thuốc lá', 'rượu', 'đồ uống có cồn',
  'súng', 'thuốc nổ', 'lựu đạn', 'bom', 'dao', 'kiếm', 'cá độ', 'cờ bạc',
  'xóc đĩa', 'vé xổ số', 'phim sex', 'link nóng', 'mại dâm', 'sex toy',
  'đường lưỡi bò', 'phản động', 'cờ vàng ba sọc', 'chống phá nhà nước', 'chống phá',
  'key win lậu', 'tài khoản hack', 'netflix crack', 'spotify crack', 'tool cày view',
  'tool spam', 'kem trộn',
];

const PROMPT_PREFIX = `Bạn là biên tập viên tin tức. Viết lại bài báo sau bằng tiếng Việt với các yêu cầu BẮT BUỘC:
- Giữ nguyên sự thật, số liệu, tên riêng, ý chính; KHÔNG bịa thêm thông tin.
- Đổi cách diễn đạt, KHÔNG chép nguyên văn câu nào từ bản gốc (tránh vi phạm bản quyền).
- TUYỆT ĐỐI KHÔNG dùng bất kỳ từ/cụm từ nào trong DANH SÁCH CẤM dưới đây — kể cả khi nó là một phần của từ ghép phổ biến. Ví dụ: "đánh giá" chứa từ cấm "đánh" → phải đổi thành "nhận định"/"ước lượng"; "kiếm tiền" chứa "kiếm" → "tạo thu nhập"/"sinh lời"; "rượu" → "bia"/"chất cồn"; "đồ uống có cồn" → "thức uống lên men"; "tai nạn" → "sự cố"; "chết" → "tử vong"/"qua đời"; "đâm" → "dùng vật nhọn"; "dao" → "vật sắc bén"; "bom" → "thiết bị nổ"; "súng" → "vũ khí"; "lậu" → "trốn thuế"; "hack" → "xâm nhập trái phép"; "hoa hồng" → "tiền giới thiệu". Luôn tìm từ thay thế an toàn.
- Giữ độ dài tương đương bản gốc, viết thành các đoạn văn mạch lạc, giọng văn báo chí trung lập.
- Chỉ trả về phần nội dung đã viết lại, KHÔNG viết tiêu đề, KHÔNG ghi chú.

DANH SÁCH CẤM (tránh tất cả): ${BANNED_WORDS.join(', ')}`;

export async function rewriteArticle(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  title: string;
  body: string;
  bannedWordsOverride?: string[]; // if 40001 returned specific words, force-avoid them on retry
}): Promise<string | null> {
  // Defense-in-depth: even a direct caller cannot point this request at a private /
  // non-https target without tripping the LLM URL policy (Threat C9).
  validateLlmBaseUrlStatic(args.baseUrl);
  const url = `${args.baseUrl.replace(/\/$/, '')}/v1/messages`;
  let prompt = `${PROMPT_PREFIX}\n\nTiêu đề: ${args.title}\n\nBài gốc:\n${args.body}`;
  if (args.bannedWordsOverride && args.bannedWordsOverride.length) {
    prompt = `${prompt}\n\nLần viết trước vẫn dính các từ cấm sau, BẮT BUỘC tránh hoàn toàn lần này: ${args.bannedWordsOverride.join(', ')}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': args.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
    redirect: 'manual', // NEVER follow — undici would re-send x-api-key to an arbitrary 3xx target.
  });
  // BLOCKER: a cross-origin redirect must abort — the keyed header never leaves the
  // validated origin. (undici does not forward headers on redirect:'manual'; we also
  // refuse every 3xx outright so no second request can be built by a caller.)
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    const loc = res.headers.get('location') || '';
    throw new Error(`LLM provider redirect not allowed (HTTP ${res.status}${loc ? ` -> ${loc}` : ''}). Không encode lại LLM_BASE_URL rồi thử lại.`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`LLM rewrite failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const content = json?.content;
  if (!Array.isArray(content)) {
    throw new Error(`LLM rewrite: unexpected response — ${text.slice(0, 300)}`);
  }
  const rewritten = content
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
    .trim();
  return rewritten || null;
}
