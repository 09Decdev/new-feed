# UI-SPEC — Web GUI cho news-poster (v1)

**Status**: Ready for Phase D (T11–T15, T17)
**Author**: UI Designer  **Ngày**: 2026-08-20
**Nguồn**: `PRD-news-poster-gui.md` (FLOW 1–6, FR-1…FR-8, §9 AC, §10) + `PLAN-news-poster-gui.md` (quyết định khách: GUI_TOKEN + trang nhập token anonymous; UI tiếng Việt; không CDN; polling 2s)
**Ràng buộc kỹ thuật**: 1 file `index.html` + `app.js` + `style.css` — vanilla JS, DOM thuần, `fetch`, không framework, không build, không CDN (kể cả font).
**Người đọc**: Frontend Developer (T11–T15, T17). Doc này CHỈ thiết kế giao diện + hành vi frontend, KHÔNG thiết kế API/backend (xem tab contract ở §6 — do Backend Architect cung cấp).

---

## 1. Tổng quan & nguyên tắc thiết kế

- **Ngôn ngữ UI**: tiếng Việt hoàn toàn (nhãn, thông báo, trạng thái). Tên tab "Dashboard" giữ nguyên theo PRD, phần còn lại tiếng Việt.
- **Một người, một máy, desktop Windows**: ưu tiên ĐƠN GIẢN, đúng việc. Mọi thứ thừa (hiệu ứng, trang trí, thông tin phụ) đều bị cắt.
- **Thông tin là trọng tâm**: GUI thay thế terminal → mỗi phần tử phải trả lời đúng 1 câu hỏi người dùng hay tự hỏi: "bot còn chạy không?", "bài cuối đăng được chưa?", "canh nào RP nào", "feed này có đọc được không?".
- **Luôn có trạng thái rõ ràng**: mọi nút bấm đều có trạng thái loading/disabled; mọi hành động ghi dữ liệu đều có xác nhận; mọi lỗi đều hiển thị bằng tiếng Việt ở khu vực gần nơi nó xảy ra (không nuốt lỗi, không để console-error duy nhất).
- **Không design backend**: doc tham chiếu endpoint có sẵn từ PLAN để mô tả luồng UI, không đề xuất/sửa contract.

---

## 2. Sitemap & layout tổng thể

### 2.1 Sitemap

```
http://127.0.0.1:8899/ → index.html (ANONYMOUS — có GUI_TOKEN hay không đều serve 200, KHÔNG gate Bearer)
│
└─ index.html — 1 trang duy nhất, 2 trạng thái trong-page (KHÔNG navigation):
     ├─ (khi GET /api/status trả 401) → Form nhập token hiện lên trong trang
     │       └─ POST /api/auth/verify OK → token vào sessionStorage → hiện app 4 tab
     └─ App 4 tab   (CHỈ request tới /api/* gắn Authorization: Bearer — static không gắn)
          ├─ [Dashboard]   — trạng thái điều khiển chính
          ├─ [Nhật ký]     — log real-time
          ├─ [Lịch sử]     — bài đã đăng + đăng thử
          └─ [Cấu hình]    — sửa config + kiểm tra feed + community
```

> **Quyết định hội đồng 2026-08-20**: static (`index.html`/`app.js`/`style.css`) serve ANONYMOUS; CHỈ gate `/api/*`. Token page KHÔNG phải trang riêng — là form trong `index.html`. Chi tiết §3 + Decision log §11.

### 2.2 Layout khung (mọi tab)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▢ news-poster                 ● Đang chạy   ·600s  ⌂ Trực tuyến  ∞2s │  ← HEADER (cố định)
├──────────────────────────────────────────────────────────────────────────┤
│  [ Dashboard ]  [ Nhật ký ]  [ Lịch sử ]  [ Cấu hình ]              │  ← thanh TAB
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                          (vùng nội dung theo tab)                       │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  (status bar, có thể có/không tuỳ trạng thái — banner lỗi/mất kết nối)  │
└──────────────────────────────────────────────────────────────────────────┘
```

**HEADER (có mặt ở mọi tab có xác thực; bị ẩn khi form token trong-page đang hiện — để tối giản):**
| Element | Mô tả | Hành vi |
|---|---|---|
| Nhãn app | `news-poster` (font-ui, weight 600) | Tĩnh. Click trở về Dashboard. |
| Badge trạng thái chung | Chip nhỏ cạnh nhau: trạng thái loop (● Đang chạy / ⏸ Đã dừng / ⚠ Lỗi / …– đang chuyển) | Gắn `data-state`, màu theo §5. Tự cập nhật mỗi poll. |
| Chu kỳ trước | text như `·600s` = thời gian kể từ `lastCycleAt` hoặc `chưa có` | Cập nhật mỗi poll phút giây. |
| Trạng thái kết nối | `⌂ Trực tuyến` (info) / `⌂ Mất kết nối` (error) / `∞2s` điểm nhấn nhịp | Poll lỗi ≥1 lần → error banner §6.2; hồi phục → tự hết. |
| Khu vực banner | dải ngang, màu theo mức độ (error/warning), ví dụ: "Mất kết nối máy chủ – đang thử lại…", "Đã có vòng lặp khác đang chạy (PID 1234)" | Duy nhất 1 banner tại một thời điểm; auto-hide khi hết nguyên nhân. |

**THANH TAB**
- Là `<nav role="tablist">`, mỗi tab là `<button role="tab" aria-selected>`. Tab đang chọn có gạch chân 2px màu `--accent-solid` + chữ `--text`, tab khác `--text-muted`.
- Chuyển tab KHÔNG reload trang; ẩn/hiện vùng nội dung (`hidden` attribute). Hành vi opening một tab đều kích hoạt `tab.onShown()` refresh dữ liệu của tab đó (mô hình "refresh on show" — xem §6.1).

---

## 3. Token gate trong-page (khi `GUI_TOKEN` bật)

**Quyết định hội đồng 2026-08-20**: static `index.html`/`app.js`/`style.css` serve **ANONYMOUS** (KHÔNG gate Bearer — nếu gate static thì máy khách không còn chỗ nạp token → deadlock). CHỈ cổng `/api/*` yêu cầu Bearer. Token page KHÔNG phải trang riêng: là form ẩn của `index.html`, hiện lên khi chưa xác thực, **không navigation**. Token lưu **sessionStorage** (phạm vi tab — reload cùng tab không mất; đóng tab = xoá).

```
┌─────────────────────────────────────────────────┐
│  ▢ news-poster        (app shell — tab ẩn)      │
│                                                 │
│            ┌───────────────────────┐            │
│            │  Nhập mã truy cập     │            │
│            │                       │            │
│            │  [ ••••••••••••      ]│            │
│            │  ⚠ Mã không đúng      │(khi lỗi)   │
│            │  ⚠ Thử lại sau 30s    │(khi 429)   │
│            │  [    Vào    ]        │            │
│            └───────────────────────┘            │
│                                                 │
│   Nhập mã từ biến GUI_TOKEN trong file .env.    │
│   Nếu không đặt mã, mở http://<máy>/ trực tiếp. │
└─────────────────────────────────────────────────┘
```

**Luồng khởi động** (KHÔNG navigation, KHÔNG tải trang khác):

1. Load `index.html` → `app.js` chạy → đọc `sessionStorage["poster-token"]` (nếu có).
2. Gọi `GET /api/status` (gắn Bearer nếu có token trong sessionStorage).
3. **200** → có xác thực → hiện app 4 tab (header + tabbar + section), bắt đầu poll §6.1.
4. **401** → ẩn app shell, hiện form token trong-page. KHÔNG dùng `location`.

   (Lưu ý: nếu hiện token page mà chưa hề nhập token — nghĩa là server bật `GUI_TOKEN` giữa chừng hoặc sessionStorage trống — vẫn là cùng form này.)

5. Submit "Vào" → gọi **`POST /api/auth/verify`** body `{token}` — KHÔNG dùng `GET /api/status` để verify (đúng contract exempt C1b / DESIGN §6.5, finding 6):
   - **200** → `sessionStorage["poster-token"] = token` → ẩn form, hiện app, gọi lại status.
   - **401** → ở lại form, message "Mã không đúng — kiểm tra GUI_TOKEN trong .env." (`role="alert"`).
   - **429** → nếu response mang `lockedUntil` (epoch ms) → vô hiệu ô + nút, hiện countdown "Thử lại sau Ns" (đếm từ `lockedUntil`, cập nhật mỗi giây; hết giờ → bật lại + xoá countdown). Không có `lockedUntil` → "Thử lại sau một lúc." (finding 11).
   - Mạng lỗi / 5xx → message gần ô, cho submit lại; không xoá token đã nhập.
6. Đang gọi verify → nút disabled + "Kiểm tra…".

| Element | Mô tả | Hành vi |
|---|---|---|
| Ô nhập token | `<input type="password" required autocomplete="current-password">` + `<label>` "Nhập mã truy cập" (label luôn nhìn thấy, không chỉ placeholder) | Autofocus khi form hiện. `Enter` = submit. `aria-invalid` + `aria-describedby` trỏ message lỗi. |
| Nút "Vào" | Primary, ô vừa phải | Submit → `POST /api/auth/verify`. Đang gọi → disabled + "Kiểm tra…". |
| Message lỗi (401) | `role="alert"` bên dưới ô, màu `--error` | "Mã không đúng — kiểm tra GUI_TOKEN trong .env." Không tiết lộ gì thêm. |
| Countdown 429 | dòng `--warning` cạnh nút | "Hệ thống khóa tạm thời do nhập sai quá nhiều — thử lại sau Ns". Ô/nút disabled tới hết thời gian. |
| Dòng hướng dẫn | text-muted nhỏ | "Nhập mã từ biến GUI_TOKEN trong file .env. Nếu không đặt mã, mở http://<máy>/ trực tiếp." |

**Token trong sessionStorage** (quyết định chung — thay cho "giữ trong memory" của PLAN T11.AC):

- `sessionStorage` phạm vi **một tab**: reload trang / chuyển tab → token còn, không phải nhập lại; đóng tab / đóng browser → tự xoá (an toàn hơn `localStorage`).
- Mọi request `/api/*` gắn `Authorization: Bearer <token>` từ sessionStorage qua fetch helper §6.3. Static/anonymous không gắn.
- Gặp **401 ở bất kỳ endpoint nào trong lúc poll** → token hết hạn/sai → xoá sessionStorage, dừng poll, hiện lại form trong-page (§6.3).

---

## 4. Chi tiết từng tab

### 4.1 Tab Dashboard

Trả lời: "Bot đang chạy không? Bài cuối thế nào? Kết nối Google ổn không? Có xung đột loop không?"

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tab Dashboard                                                             │
│                                                                            │
│  ┌───────────────┬──────────────────────────────────────────────────────┐  │
│  │ STATUS CARD   │   [ ▶ Bắt đầu ]   (primary; ẩn khi Đang chạy)        │  │
│  │  ● Đang chạy  │   [ ⏹ Dừng ]      (danger;  mờ khi Đã dừng)         │  │
│  │  ·từ 12:04    │                                                      │  │
│  └───────────────┴──────────────────────────────────────────────────────┘  │
│                                                                            │
│  ⚠ Đã có vòng lặp khác đang chạy (PID 1234). Đang khởi động bị tắt.       │
│   (banner warning — chỉ khi lockHeldBy)                                   │
│                                                                            │
│  ┌─ CẤU HÌNH ĐANG HIỆU LỰC ─────┐   ┌─ KẾT QUẢ BÀI CUỐI ────────────────┐ │
│  │ Feed      vnexpress.net/rss… │   │ ✓ Đăng thành công                  │ │
│  │ Mỗi chu kỳ   1 bài (900s)    │   │   "VnExpress đóng cửa…"            │ │
│  │ Cộng đồng  com_abc123        │   │   postId: 66c…  · 12:04            │ │
│  │ Định dạng  CLASSIC           │   │  (hoặc ⨯ Thất bại + reason,        │ │
│  │ Chế độ     Đăng thật         │   │   hoặc "chưa có bài nào")          │ │
│  └──────────────────────────────┘   └────────────────────────────────────┘ │
│  ┌─ TRẠNG THÁI GOOGLE ──────────────────────────────────────────────────┐ │
│  │  ✅ Đã kết nối — token còn 43 phút        (success)                   │ │
│  │  (hoặc ⚠ Token hết hạn, sẽ tự làm mới)   (warning)                   │ │
│  │  (hoặc ⛔ Chưa kết nối)                    [ Kết nối Google ]         │ │
│  │  (hoặc ⛔ Có 2FA/register → dòng lỗi tiếng Việt, nút thử lại)         │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│  ┌─ THỐNG KÊ ──────────────┐                                              │
│  │ Chu kỳ đã chạy  12      │                                              │
│  │ Bài hôm nay     5/7      │   (postedToday)                              │
│  └─────────────────────────┘                                              │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Mô tả | Hành vi |
|---|---|---|
| **Status card** | Badge lớn + text trạng thái (map §5.1) | `RUNNING`→"Đang chạy" (success), `STOPPED`→"Đã dừng" (neutral), `STARTING`→"Đang khởi động…", `STOPPING`→"Đang dừng… (chờ hết chu kỳ)", `ERROR`→"Lỗi: <message>" (error). Dòng phụ: "từ <giờ>" từ `lastCycleAt` hoặc "chưa chạy lần nào". |
| **Nút ▶ Bắt đầu** | Primary | Ẩn khi RUNNING. Click → `POST /api/start`. Ngay lập tức: disabled + text "Đang khởi động…" (chống double-click, AC-2 PRD). Trạng thái mong đợi RUNNING ≤3s. |
| **Nút ⏹ Dừng** | Danger (bordered) | Ẩn khi STOPPED. Click → `POST /api/stop`. Disabled + "Đang dừng…" ngay. STOPPED ≤5s (gồm cả trường hợp đang ngủ giữa interval — quyết định T1.AC.6). |
| **Chống double-click (bắt buộc)** | — | Mọi nút có thao tác bất đồng bộ: khi đang gọi API hoặc state đang STARTING/STOPPING → `disabled` (CSS `cursor: not-allowed`). Chỉ trả về tương tác khi server xác nhận state mới. Nếu server trả 409 (start khi đã chạy / lock bận) → hiện message gần nút, không nuốt. |
| **Banner lock** | warning, `role="alert"` | Khi `lockHeldBy` có giá trị (loop khác nắm lock — T23): "Đã có vòng lặp khác đang chạy (PID <n>). Hãy dừng nó ở terminal/PM2 rồi mới Bắt đầu." Nút Start bị disable kèm tooltip lý do. |
| **Card Cấu hình đang hiệu lực** | list key–value, mono cho URL | Từ `config` snapshot trong `/api/status`. Đọc-only. Hiển thị feed (rút gọn giữa với `…`), interval (hiện phút giây), community, layout, dry-run ("Đăng thật"/"Chế độ thử"). Ghi chú nhỏ: "Sửa ở tab Cấu hình — áp dụng từ chu kỳ kế tiếp." |
| **Card Kết quả bài cuối** | `lastPostResult` | `ok=true` → badge ✓ Đăng thành công (success) + title + postId. `ok=false` → ⨯ Thất bại (error) + reason (vd "vi phạm nội dung", "không có quyền — unauthorized", "HTTP 4xx/5xx <msg>"). Null → empty state "Chưa có bài nào được đăng." Thời gian cạnh dưới. |
| **Card Trạng thái Google** | auth-status (`hasSession`, `accessExpiresAt`, `hasGoogleRefresh`, `communityPermission`) | Bốn trạng thái: (1) success khi có session hợp lệ — kèm "còn ~X phút"; (2) warning khi `accessExpiresAt` quá khứ nhưng `hasGoogleRefresh` → "Token đã hết hạn — bot sẽ tự làm mới khi chạy" (không cần can thiệp); (3) error khi `hasSession=false` → "Chưa kết nối Google" + nút **[ Kết nối Google ]** (primary khác màu) → `POST /api/setup/start` → **giữ tham chiếu popup**: `const popup = window.open(consentUrl, '_blank', 'noopener,noreferrer')` → sau đó poll auth-status tự cập nhật; (4) warning khi `communityPermission=false` → "Không có quyền POST_CONTENT trong community đã cấu hình — vòng lặp sẽ không chạy." |
| **Sau khi /callback — đóng popup (BẮT BUỘC, finding 2)** | — | Server nhận redirect rồi lưu session (backend lo). `/callback` là HTML tĩnh + CSP cấm inline JS (THREAT §6.4) → popup KHÔNG tự đóng được. Tab chính giữ `const popup` từ lúc mở; **mỗi poll** kiểm tra: nếu `auth.hasSession===true` hoặc `lastOAuthError!=null` → gọi `popup.close()`. `lastOAuthError!=null` đồng thời render card lỗi tiếng Việt (finding 8: UI chỉ render `lastOAuthError` qua `textContent` — backend đã map/sanitize tiếng Việt theo DESIGN §8.13; nếu field vắng → card lỗi chung, KHÔNG render body lỗi thô). Popup bị đóng bằng tay trước đó cũng vô hại. `hasSession=true` → card đổi success, không reload. |
| **Card Thống kê** | `cycleCount`, `postedToday` | Số liệu thô, text default, không cần chart (tránh rườm rà). |

**Lỗi thân thiện FLOW 6** (từ `auth.client.ts`): server trả message phân biệt cho 2FA (`require2fa`) và register khi `loginWithGoogle` fail → UI hiện card lỗi tiếng Việt:
- 2FA: "Tài khoản Google này có bật xác thực 2 bước (2FA) — bot chưa hỗ trợ. Hãy tắt 2FA cho tài khoản rồi thử lại."
- register: "Tài khoản Google chưa được đăng ký trên nền tảng. Đăng ký một lần qua app hoặc social rồi thử lại."
- Khác: "Kết nối Google thất bại: <message thô ngắn gọn>". Kèm nút "Thử lại".

### 4.2 Tab Nhật ký

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tab Nhật ký                                                               │
│                                                                            │
│  [ ● Mọi ▾ ]        [ ⊘ Xóa nhật ký ]           [ 📌 Theo cuối ] ON       │
│   filter dropdown     clear (chỉ màn hình)         auto-scroll toggle      │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 12:04:12 [news-poster] Pre-flight OK (role=OWNER). Starting loop…  │  │
│  │ 12:04:13 [news-poster] Fetching RSS: https://vnexpress.net/rss…    │  │
│  │ 12:04:14 [LLM]  rewritten (1234 chars)                             │  │
│  │ 12:04:15 [OK]   Posted: "VnExpress đóng cửa…" -> 66c…               │  │
│  │ 12:04:15 [news-poster] Cycle done. Sleeping 600000ms…              │  │
│  │ ⏷ (dòng mới tự chèn, thanh cuộn luôn ở đáy khi Theo cuối bật)      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Mô tả | Hành vi |
|---|---|---|
| Bộ lọc | `<select>` 3 giá trị: **Mọi / Lỗi / Bỏ qua** | Mọi: tất cả. Lỗi: dòng chứa `[FAIL]`, hoặc regex `/error|failed|thất bại|không đăng được/i` (phủ `RSS fetch failed`, `Auth error`, `rewrite failed`, `upload failed`). Bỏ qua: dòng chứa `[SKIP]`. Đổi bộ lọc chỉ lọc hiển thị, không gọi API lại. |
| Nút Xóa | "Xóa nhật ký" (bordered, nhỏ) | Xóa **toàn bộ DOM hiển thị của tab**, nhưng **giữ `lastSeq`** → sau đó chỉ các dòng mới (`seq > lastSeq`) được thêm vào (không tải lại 1000 dòng cũ). Có xác nhận nhẹ "Đã xóa hiển thị" (toast). |
| Toggle Theo cuối | Chip bật/tắt (mặc định BẬT) | Bật → cuộn về đáy khi có dòng mới. **Pause auto-scroll (finding 10)**: khi user cuộn lên khỏi vùng đáy (>24px) → treo auto-scroll (dòng mới vẫn được thêm, hiện badge đếm "có N dòng mới" để bấm nhảy xuống); khi user quay về đáy → tự resume + xoá badge. Tắt → thêm dòng không tự cuộn + badge đếm như trên. |
| Panel log | `role="log"`, `aria-live="off"` (tránh đọc màn hình đọc liên tục); scroll container riêng, font mono | Mỗi dòng: `[giờ HH:MM:SS]` + text gốc. Màu theo prefix (§5.2). Nền tối nhẹ `--code-bg` để dễ đọc khối text dài. |
| Backlog | Tải tối đa 1000 dòng gần nhất khi mở tab lần đầu (API không `since`) | Render bằng một lần thêm DOM (không render từng dòng trong vòng lặp — dùng `DocumentFragment`), tránh giật. |
| Reset con trỏ (`data.reset`) | **BẮT BUỘC xử lý (finding 1)** — theo DESIGN §8.2 | Khi poll trả `reset:true` (client since tiến về trước cap → server ném `since<firstSeq`; hoặc sau restart process `firstSeq=0,lastSeq=0`) → **xoá toàn bộ log hiển thị hiện tại**, gán `lastSeq = data.lastSeq`, render đúng backlog trả về (thường là 1000 dòng gần nhất) như đợt tải đầu. Không nuốt log, không gap. |
| Poll | Mỗi poll gọi `GET /api/logs?since=<lastSeq>` | Nếu `data.reset===true` → xử lý hàng Reset con trỏ ở trên. Ngược lại → append các dòng `seq > lastSeq`, cập nhật `lastSeq = data.lastSeq`. Không trùng lặp. |

**Màu theo prefix log (mapping từ poster.ts):**
| Prefix | Mức | Giải thích UI |
|---|---|---|
| `[OK]` | success | Bài đăng thành công → đọc ngay trong đống log. |
| `[FAIL]` | error | Đăng thất bại. |
| `[SKIP]` | warning | Đã đăng trước → bỏ qua. |
| `[LLM]` | info | Bước AI viết lại (không lỗi/cảnh cáo). |
| `[IMG]`, `[DRY]` | muted | Phụ trợ: ảnh, dry-run. |
| `[news-poster]` mọi dòng khác | default | Điều hướng/vòng lặp (fetch, sleep, chuyển state). Sự kiện lỗi trong nhóm này (`RSS fetch failed`, `Auth error`) được tô error thay vì default. |

### 4.3 Tab Lịch sử

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tab Lịch sử                                                               │
│                                                                            │
│  [ 🔄 Làm mới ]  [  Đăng thử 1 bài  ] (primary)     Lọc: [Mọi ▾]        │
│                                                                            │
│  ┌───────────────┬─────────────────────┬─────────┬───────────┬───────────┐ │
│  │ Trạng thái    │ Tiêu đề / Nguồn     │ Thời gian│ Post ID   │ Lý do     │ │
│  ├───────────────┼─────────────────────┼─────────┼───────────┼───────────┤ │
│  │ ✓ Đăng        │ "VnExpress đóng…"   │ 12:04   │ 66c…      │ —         │ │
│  │  ↗ nguồn      │                     │         │           │           │ │
│  │ ⟳ Bỏ qua      │ "Tuổi trẻ đấu giá…" │ 11:30   │ —         │ đã đăng  │ │
│  │ ⨯ Thất bại    │ "Đánh giá MU…"      │ 10:00   │ —         │ vi phạm …│ │
│  │ — (bài cũ)    │ "Bài từ trước nâng…"│ 05/08   │ —         │ —         │ │
│  └───────────────┴─────────────────────┴─────────┴───────────┴───────────┘ │
│  Không có bài nào được ghi nhận. (empty state)                              │
│                                                                            │
│  ┌─ MODAL: Đăng thử 1 bài ───────────────────────────────────────────────┐ │
│  │  Nguồn:  (•) RSS feed đang cấu hình   ( ) URL bất kỳ                  │ │
│  │          [ https://…                                 ]                │ │
│  │  Số bài: [1]    ☑ Chạy thử (dry-run — không đăng thật)                │ │
│  │  ───────────────────────────────────────────────────────────────────── │ │
│  │  [ Xem trước ]                              (primary)                  │ │
│  │  Nội dung dự kiến (preview box, mono, scroll ≤ 400px):                 │ │
│  │   "Tiêu đề…\n\nĐoạn rewrite…\n\nNguồn: …"                              │ │
│  │  [ Đóng ]   [ ✓ Đăng bài này ]  (disabled khi đang xem thử / bot chạy) │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Mô tả | Hành vi |
|---|---|---|
| Bảng | 6 cột: Trạng thái, Tiêu đề (kèm link nguồn), Thời gian, Post ID, Lý do | Dữ liệu `GET /api/history?limit=100`. Sorted ts giảm dần (backend lo). |
| Status badge | posted → success "✓ Đăng"; skipped → info "⟳ Bỏ qua"; failed → error "⨯ Thất bại"; legacy entry thiếu field → muted `—` | Hiển thị `status`, reason ở cột "Lý do". |
| Cột Tiêu đề / Nguồn | Title text không bọc màu + nút nhỏ "↗ nguồn" | Click "↗ nguồn" hoặc click cả cell → **validate protocol trước khi mở (finding 7)**: link từ `posted.json`/feed là dữ liệu stored-hostile → chỉ mở khi `new URL(link)` thành công VÀ `protocol∈{http:,https:}`; lỗi parse/protocol lạ (`javascript:`, `data:`, …) → KHÔNG mở, chỉ giữ `title` tooltip. Mở bằng `window.open(link, '_blank', 'noopener,noreferrer')`. Title dài cắt 1 dòng ellipsis, tooltip title đầy đủ. |
| Cột Post ID | default-text mono, nhỏ | Không cần hành động; bài cũ/không có → `—`. |
| Nút Làm mới | bordered | Gọi lại history + render. (Tab tự refresh mỗi poll — §6.1; nút để ép ngay.) |
| Lọc trạng thái | select Mọi/Đăng/Bỏ qua/Thất bại | Gọi `?status=` khi backend hỗ trợ, hoặc lọc client cho tiện (ưu tiên nhất quán với API). |
| **Nút "Đăng thử 1 bài"** | primary, mở modal | Bị disable khi bot `STARTING/RUNNING/STOPPING` (guard 409 — T9) **HOẶC `status.lock.held===true`** (vòng lặp PM2/`npm start` khác đang giữ lock — T23; tránh 2 writer `posted.json`, R15) (finding 3). Tooltip theo lý do: "Đang dừng bot trước khi đăng thử." / "Đã có vòng lặp khác đang chạy (PID N) — dừng nó ở terminal/PM2 rồi thử lại." |
| **Modal preview** | `role="dialog" aria-modal="true"` | Mở bằng nút trên. Esc / click overlay / nút Đóng → đóng. Focus ban đầu vào radio nguồn. |
| — Nguồn | Radio 2 lựa chọn: (•) RSS feed đang cấu hình, ( ) URL bất kỳ → ô URL (prefill config) | Nhắc lại rõ cho user đây là "đăng thử 1 bài". |
| — Số bài | number min 1 (mặc định 1) | Giới hạn hiển thị trong preview. |
| — ☑ Chạy thử (dry-run) | checkbox, default ON | ON → gọi `POST /api/post {dryRun:true}` trả preview TEXT, KHÔNG đăng. OFF → nút "✓ Đăng bài này" active, trước khi đăng vẫn hiện để xem lần cuối. |
| — Nút Xem trước | primary | Gọi dry-run, render nội dung vào preview box (mono, scroll). Lỗi (RSS hỏng, không có item, không có quyền) → hiển thị ngay dưới box bằng `--error`. |
| — Nút "✓ Đăng bài này" | disabled khi đang dry-run chưa xem / khi đã bấm 1 lần | Đăng thật (`dryRun:false`). Xong → toast success/fail, đóng modal, bảng lịch sử tự refresh (poll hoặc ép refresh ngay). Nút này nằm dưới preview box, màu primary — user có chủ ý mới đăng. |
| — Trạng thái bot RUNNING | | Nếu 409 bất ngờ (bot vừa được Start từ tab khác) → giữ modal, hiện message warning gần nút. |

**Note dry-run thêm:** khi nhánh `( ) URL bất kỳ` được chọn và dry-run BẬT, preview chính là kết quả `fetchRssItems` + `buildContent` trên feed đó — tái dùng đúng logic one-shot, không code mới.

### 4.4 Tab Cấu hình

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tab Cấu hình                                                              │
│  ⚠ Lưu ý: thay đổi áp dụng từ CHU KỲ KẾ TIẾP (không cần khởi động lại).   │
│                                                                            │
│  ┌─ NGUỒN RSS ──────────────────────────┐  ┌─ CHU KỲ ────────────────────┐ │
│  │ RSS_FEED_URL* [ https://…__________ ]│  │ POST_INTERVAL_MS [900 000]—│ │
│  │ RSS_LIMIT_PER_CYCLE [1]  bài/chu kỳ  │  │  (hiển thị phụ: ≈15 phút)  │ │
│  │ [🧪 Kiểm tra feed]  [kết quả bên dưới]│  └────────────────────────────┘ │
│  └───────────────────────────────────────┘                                 │
│  ┌─ NƠI ĐĂNG ────────────────────────────┐  ┌─ ĐỊNH DẠNG ────────────────┐ │
│  │ COMMUNITY_ID [ com_abc…___________ ]  │  │ LAYOUT_TYPE [CLASSIC ▾]   │ │
│  └───────────────────────────────────────┘  └────────────────────────────┘ │
│  ┌─ BOT ────────────────────────────────┐  ┌─ AI VIẾT LẠI ───────────────┐ │
│  │ DRY_RUN          ☐ Đăng thử (không…)│  │ REWRITE_WITH_AI ☑ Bật        │ │
│  │                                       │  │ LLM_BASE_URL [https://…    ] │ │
│  │                                       │  │ LLM_MODEL [deepseek-…      ]│ │
│  │                                       │  │ LLM_API_KEY [••••••••] +[Đặt mới][Xóa]│
│  └───────────────────────────────────────┘  └────────────────────────────┘ │
│  (GOOGLE_CLIENT_ID_WEB: read-only; GOOGLE_CLIENT_SECRET_WEB: •••• + [Đặt mới][Xóa])│
│                                                                            │
│  [ 💾 Lưu cấu hình ]                                          (primary)    │
│  toast: "Đã lưu ✓ — áp dụng từ chu kỳ kế tiếp."                            │
│                                                                            │
│  KIỂM TRA FEED (kết quả):           ┐          CỘNG ĐỒNG:                  │
│  ┌──────────────────────────────┐   │          ┌───────┬─────┬─────┬──────┐ │
│  │ ✓ 3 bài, có preview đầu tiên: │   │          │ ID    │Tên  │Vai  │Quyền │ │
│  │ "Tiêu đề bài 1" + nội dung…   │   │          │ com_a │ …   │OWNER│✓ Đăng│ │
│  │ "Tiêu đề bài 2" …            │   │          │ com_b │ …   │MEMBER│—     │ │
│  └──────────────────────────────┘   │          └───────┴─────┴─────┴──────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Mô tả | Hành vi |
|---|---|---|
| Banner ghi chú | warning-info nhẹ ở đầu tab | "Các thay đổi được áp dụng từ CHU KỲ KẾ TIẾP — không cần khởi động lại bot." (bắt buộc hiển thị — quyết định khách §10.2). |
| Nhóm form | 5 thẻ card nhỏ, các field có label bên trên, input full-width; `*` = bắt buộc | Dữ liệu từ `GET /api/config`. Num/url/select/checkbox đúng kiểu. |
| POST_INTERVAL_MS | number; hiển thị kèm text phụ `≈ 15 phút` (tự tính ms→phút) | Tránh nhập sai đơn vị. |
| LAYOUT_TYPE | `<select>` giá trị khả dụng (CLASSIC + các giá trị layout hệ thống) | Load từ API; mặc định CLASSIC. |
| Secret (LLM_API_KEY, GOOGLE_CLIENT_SECRET_WEB) | MASK: ô hiển thị chuỗi `••••••••` + text trạng thái `set: "đã đặt"/"chưa đặt"` + 2 nút **[ Đặt mới ]** **[ Xóa ]** | **Không bao giờ render giá trị thật** (FR-5/AC-8 PRD). Mỗi secret có trạng thái UI riêng: `GIỮ` (mặc định) / `SỬA` (đang nhập giá trị mới) / `XÓA` (đánh dấu xoá). **Semantics gửi `*_SET` (finding 4 — bỏ mâu thuẫn cũ "bỏ trống + Lưu = giữ cũ" vs "xoá trắng = xoá secret")**: CHỈ đưa field `*_SET` vào body `POST /api/config` khi user CHỦ ĐỘNG đổi trạng thái — `SỬA` (đã nhập giá trị) → `*_SET:"<giá trị>"`; `XÓA` → `*_SET:""`; `GIỮ` → KHÔNG gửi field (backend giữ nguyên, đúng DESIGN §3.2 — bỏ trống thông thường là vô hại, mọi sửa chỉ qua hành động tường minh). |
| — Bấm **[ Đặt mới ]** | chuyển `GIỮ`→`SỬA` | Ẩn `••••`, hiện `<input type="password" placeholder="Nhập giá trị mới…">` + nút "Hủy". Nhập giá trị → trạng thái `SỬA` (có giá trị). "Hủy" → về `GIỮ` (xoá giá trị đã nhập, không gửi field nào). |
| — Bấm **[ Xóa ]** | chuyển `GIỮ`→`XÓA` | Ô hiện placeholder "Sẽ bị xóa khi lưu" (màu `--warning`) + nút "Hủy xóa" để về `GIỮ`. Không cần nhập gì cả. |
| — Nút "Lưu cấu hình" với secret | theo trạng thái từng secret | `SỬA` → gửi `*_SET:"<giá trị>"`; `XÓA` → gửi `*_SET:""`; `GIỮ` → field vắng mặt trong body. Sau lưu: snapshot cập nhật qua poll (secret vừa SỬA → `set:true`; vừa XÓA → `set:false`). Không reload-toàn-form (tránh mất trạng thái field khác). |
| GOOGLE_CLIENT_ID_WEB | read-only text (không phải secret — hiển thị để biết client đang dùng) | Không editable trong v1 (đổi bằng .env). |
| Nút "Kiểm tra feed" | bordered, cạnh RSS_FEED_URL | Gọi `GET /api/rss-preview?url=<giá trị đang nhập>` → render vùng kết quả bên dưới: số item tìm thấy + preview item ĐẦU TIÊN (title + teaser) + item bất kỳ nào tiếp theo dạng danh sách gọn. Lỗi → box đỏ: "Không đọc được feed: <msg>". Đang gọi → disabled "Đang kiểm tra…". |
| Nút "Lưu cấu hình" | primary, cuối form | `POST /api/config` với **chỉ field allowlist + secret qua `*_SET`**. Ghi xong → toast success "Đã lưu ✓ — áp dụng từ chu kỳ kế tiếp." Nếu 409/400 → hiện lỗi gần nút, giữ giá trị người nhập. Sau lưu: reload snapshot config ở Dashboard (poll tự cập nhật). Không tự reload-toàn-form (tránh mất trạng thái secret field). |
| Nút "Đặt lại mọi thứ" / reset-to-default | — (ngoài scope v1; KHÔNG thêm để giữ đơn giản — PRD không yêu cầu) | — |
| **Community list** | Bảng phụ trong tab: ID, Tên, Vai trò, Quyền | `GET /api/communities`. "Vai trò": OWNER/MEMBER… (`--info-badge`); "Quyền": `✓ Đăng` nếu canPost, `—` nếu không (`--muted`). Ô **COMMUNITY_ID**: nút nhỏ "'''" cạnh từng dòng "Dùng" → điền ID vào field và tô highlight; hoặc dropdown select các id. Dùng dropdown select (đơn giản, không sai chính tả), kèm fallback nhập tay. |
| Empty state community | không lấy được / chưa kết nối | "Chưa lấy được danh sách cộng đồng — kiểm tra kết nối Google ở Dashboard." + nút thử lại. |

---

## 5. Quy ước trạng thái & màu

### 5.1 Color roles (một bảng duy nhất cho cả app — KHÔNG dùng tên màu brand)

| Role | Dùng cho | Text/border nhạt (ác lên nền surface) | Nền badge soft |
|---|---|---|---|
| **success** | Đang chạy, đăng OK, đã kết nối, canPost | `--success` (#157347) | `--success-bg` (#e6f4ec) |
| **warning** | SKIP, 2FA cần can thiệp, hết hạn sẽ tự refresh, sắp hết hạn, lock bận | `--warning` (#9a5b00) | `--warning-bg` (#fbf1df) |
| **error** | FAIL, lỗi, mất kết nối, đăng thất bại, 409 | `--error` (#b42318) | `--error-bg` (#fce8e6) |
| **info** | Kết nối Google, DRY, LLM, badge auth cần hành động "Kết nối Google" | `--info` (#1f5bc2) | `--info-bg` (#e7eefc) |
| **neutral/muted** | trạng thái dừng, chưa có dữ liệu, `—` | `--text-muted` (#5f6b76) | `--surface-2` |

- **Chỉ định nghĩa màu qua custom properties** — code không hardcode hex tên màu ở nơi khác (§8).
- **Không dùng màu đơn độc**: mọi trạng thái đều có **chữ/nhãn** kèm ("✓ Đăng", "Đang chạy", "—"), màu là phụ trợ (không phải kênh thông tin duy nhất — accessibility §7).

### 5.2 State máy của Dashboard → visual

| State | Badge | Nút | Khác |
|---|---|---|---|
| STOPPED | ⏸ Đã dừng (neutral) | ▶ Bắt đầu enabled; ⏹ ẩn | — |
| STARTING | … Đang khởi động (info, blink nhẹ) | cả 2 disabled | — |
| RUNNING | ● Đang chạy (success) | ▶ ẩn; ⏹ Dừng enabled | — |
| STOPPING | … Đang dừng (warning, blink) | cả 2 disabled | ghi chú "chờ hết chu kỳ hiện tại" |
| ERROR | ⚠ Lỗi: <message> (error) | ▶ enabled (thử lại); ⏹ ẩn | message hiển thị rõ, không quá 2 dòng |

### 5.3 Loading state
- Nút đang chạy tác vụ: `disabled` + swap text suffix "…" (vd "Đang khởi động…", "Đang kiểm tra…", "Đang lưu…"). Không thêm spinner phức tạp; 1 vòng quay CSS thuần 16px (không asset) TUỲ CHỌN — tối giản là đủ.
- Vùng dữ liệu chưa về lần đầu: skeleton nhẹ (2–3 dòng khối xám `@keyframes pulse`, respect `prefers-reduced-motion`) hoặc text-muted "Đang tải…". Sau lần đầu, poll cập nhật im lặng.

### 5.4 Disabled state
- `opacity .45` + `cursor: not-allowed` + giữ cấu trúc (không đổi layout khi disable).
- Disabled có tooltip `title` giải thích tại sao (vd "Bot đang chạy — dừng trước khi đăng thử").

### 5.5 Error state
- Message lỗi: text `--error` trên nền `--error-bg`, dùng `role="alert"`, đặt NGAY cạnh nút/ô gây lỗi.
- Toast: mảnh nhỏ ở góc dưới phải, auto-hide 4s, `role="status"`. Dùng cho xác nhận nhẹ (đã lưu, đã xóa, đăng thành công). Không dùng cho lỗi cần hành động.

### 5.6 Empty states (viết tiếng Việt, có hướng dẫn kế tiếp)
- Nhật ký chưa có dòng: "Chưa có hoạt động nào — bắt đầu bot để xem log." 
- Lịch sử trống: "Chưa có bài nào được ghi nhận."
- Kết quả bài cuối null: "Chưa có bài nào được đăng." (màu muted)
- Community rỗng/không kết nối: mục 4.4. Trung tâm, dấu hiệu nhẹ (icon dash), không bảng toàn trắng.

---

## 6. Component behavior — phía frontend

### 6.1 Poll logic (bắt buộc khớp quyết định khách: polling 2s, không SSE)

- **Một timer trung tâm** setInterval 2000ms. Mỗi tick:
  1. Nếu tab đang mở là Dashboard → gọi `GET /api/status`.
  2. Nếu đang mở Nhật ký (BẬT dù tab khác đang chọn cũng hữu ích — nhưng đơn giản: chỉ khi tab Nhật ký đang hiển thị hoặc đã từng mở) → gọi `GET /api/logs?since=<lastSeq>`.
  3. Nếu đang mở Lịch sử → gọi `GET /api/history?limit=100` (tải nhẹ; nếu muốn tiết kiệm, chỉ refetch khi `lastPollCount` đổi).
  4. Nếu đang mở Cấu hình → KHÔNG tự refetch form (tránh ghi đè input người đang sửa); chỉ refetch khi vừa mở tab, sau lưu, sau kiểm tra feed, hoặc nút "Làm mới".
- **Cache/promise**: từng request độc lập (Promise riêng) — status hỏng không chặn log. Lần poll tiếp theo không chờ lần trước (chống treo nếu server chậm), nhưng dùng biến `inFlight` chống gửi trùng khi response chưa về.
- **Tab switching**: `onShown(tab)` = refetch ngay + bật cờ cần poll cho tab đó; `onHidden` = tắt cờ. Mục tiêu: ít request nhất có thể, đúng data tại thời điểm nhìn thấy.
- **Thứ tự ưu tiên**: KHÔNG block main-thread nhiều — toàn bộ render bằng DOM thuần, bảng < 100 dòng nên không cần virtual scroll.

### 6.2 Mất kết nối (offline/error)
- Lần poll thất bại (network error/HTTP 5xx, không phải 401): tăng bộ đếm lỗi liên tiếp. Từ lần 1 → banner error toàn app: "⌂ Mất kết nối máy chủ — đang thử lại tự động…" Nút thử lại thủ công (bên trong banner) — but auto-retry vẫn chạy.
- Bộ đếm lỗi ≥ 2 → treo thêm chậm dần (không bắt buộc v1, có thể giữ 2s đều).
- Hồi phục (1 request thành công) → reset bộ đếm, ẩn banner, tab đang mở refetch.

### 6.3 Fetch helper + Bearer + 401 + 429
- 1 helper chung: `api(path, {method, body, silent}) → Promise<{ok, status, data}>`. Static/HTML không qua helper này (chúng anonymous — không cần Bearer).
- Tự gắn `Authorization: Bearer <sessionStorage["poster-token"]>` **chỉ cho các request `/api/*`** (chỉ API gate — quyết định hội đồng; asset tĩnh không gắn). Không có token → gửi thẳng (server trả 401 → form token trong-page).
- Parse JSON; `json.content-type != json` → lỗi hiểu được.
- **401 từ mọi endpoint** (kể cả khi poll): dừng poll, xoá token khỏi sessionStorage, **hiện lại form token trong-page** (§3 bước 4, không navigation). Nếu local không hề có token mà 401 → nghĩa là server bật `GUI_TOKEN` giữa chừng → cũng hiện form. Không hiển thị body lỗi thô cho user.
- **429 RATE_LIMITED**: là `{retryable:true}`. Nếu response mang `lockedUntil` → hiện countdown ở form token (mục §3) hoặc message gần nút nếu là endpoint khác; không có field → message chung "Thử lại sau một lúc."
- 409/400: giữ nguyên state, render message tiếng Việt từ `data.message` nếu có, nếu không có → message an toàn mặc định.

### 6.4 Toasts & confirm
- Mọi hành động ghi dữ liệu từ UI (start, stop, post, save config, đặt lại secret) đều: nút disabled trong lúc gọi → toast kết quả.
- Chỉ "Đăng bài này (thật)" cần confirm inline (nút đã nằm trong modal preview) — không cần `confirm()` hệ thống, giữ hiện đại tối giản.

---

## 7. Responsive & Accessibility (v1 — tối thiểu, đúng scope)

### 7.1 Responsive
- **Mục tiêu: desktop tối thiểu** (Windows, browser ≥ 1024px rộng). Layout dùng CSS Grid: header × tab × content; card dashboard `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`.
- < 900px: card về 1 cột, bảng lịch sử cho phép cuộn ngang (`overflow-x:auto`), không chasing mobile đẹp.
- Container chính: `max-width: 1200px; margin: 0 auto; padding: 0 var(--space-4)`.

### 7.2 Accessibility cơ bản (không full audit, scope v1)
| Hạng mục | Yêu cầu tối thiểu |
|---|---|
| Label | Mọi `<input>/<select>` có `<label>` luôn nhìn thấy (không phụ thuộc placeholder). Field bắt buộc có dấu `*` + legend. |
| Focus | Mọi phần tử tương tác có `:focus-visible` rõ: `outline: 2px solid var(--focus-ring); outline-offset: 2px`. Không `outline:none` loại bỏ. |
| Bàn phím | Tab điều hướng toàn bộ app. Tab bar dùng tablist pattern (mũi tên trái/phải để chuyển tab + `aria-selected`). Modal: focus vào lúc mở, `Esc` đóng, focus trả về nút gốc. |
| Contrast | Theo token §8: text chính trên surface ≥ 4.5:1; text-muted chỉ dùng cho nội dung phụ (không phải trạng thái quan trọng); badge màu role luôn kèm text nhãn. |
| Ngữ nghĩa | `<nav>`, `<main>`, `<table>`, `role="alert"` cho lỗi, `role="status"` cho toast, `role="log"` cho panel log, `role="dialog"` cho modal. `lang="vi"` trên `<html>`. |
| Motion | `@media (prefers-reduced-motion: reduce)` → tắt blink, tắt pulse, chuyển opacity thay vì transform. |
| Touch/HIT | Nút tối thiểu `min-height: 36px`; tab min 40px; (mobile 44px — out of scope). |
| Màn hình đọc | Không `div` giả nút; log dùng `aria-live="off"` (trường render 1000 dòng — tránh ream). Không bắt buộc đo bằng tool trong v1 (G7 dùng mắt + tab). |

---

## 8. Design tokens (CSS custom properties — MỘT hệ thống duy nhất)

File `style.css` mở đầu bằng khối `:root` duy nhất. Mọi component đọc token — không hardcode giá trị rời rạc để đảm bảo các trạng thái visual "đọc ra một thể thống nhất".

```css
:root {
  /* ── Màu: nền / bề mặt / viền / chữ ─────────────────────────── */
  --bg:            #f4f5f7;   /* nền ngoài, vùng chết */
  --surface:       #ffffff;   /* card, header */
  --surface-2:     #e9ebee;   /* nền phụ: input disabled, badge neutral */
  --border:        #d4d8dd;
  --border-strong: #aab2bb;
  --text:          #1d232a;   /* chữ chính — trên surface AA */
  --text-muted:    #5f6b76;   /* chỉ cho nội dung phụ/vô nghĩa thứ cấp */
  --text-inverse:  #ffffff;

  /* ── Màu: role trạng thái (semantic) — text trên nền surface ≥4.5:1 ── */
  --success:       #157347;   --success-bg: #e6f4ec;
  --warning:       #9a5b00;   --warning-bg: #fbf1df;
  --error:         #b42318;   --error-bg:   #fce8e6;
  --info:          #1f5bc2;   --info-bg:    #e7eefc;

  /* ── State ────────────────────────────────────────────────── */
  --focus-ring: var(--info);
  --disabled-opacity: .45;
  --code-bg:      #1e2227;   /* nền panel log (tối để nổi text màu) */
  --code-text:    #e6e9ec;

  /* ── Typography ────────────────────────────────────────────── */
  --font-ui:  system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace;
  --fs-xs: 12px; --fs-sm: 13px; --fs-md: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 24px;
  --lh-tight: 1.25; --lh-normal: 1.5;

  /* ── Space (base 4px) ──────────────────────────────────────── */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;

  /* ── Radius / shadow ───────────────────────────────────────── */
  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / .06);

  /* ── Hit sizes ─────────────────────────────────────────────── */
  --hit-min: 36px;
}
```

**Quy tắc token:**
- Chỉ tham chiếu role (`--success`, không dùng `green`). Không hardcode hex ngoài `:root`.
- Badge = đúng role: `color: var(--role); background: var(--role-bg);` (ví dụ `.badge--success`).
- Typography duy nhất `--font-ui` + `--font-mono` (chỉ log/preview/content dùng mono). Size dồn về scale trên; không tự đặt px lẻ.
- Dark-mode (`prefers-color-scheme: dark`) đánh dấu TUỲ CHỌN v2 — v1 chỉ render light. Nếu làm, override đúng các biến trên trong block media quey (không viết lại component).

---

## 9. Yêu cầu về 3 file triển khai

| File | Nội dung | Ghi chú |
|---|---|---|
| `index.html` | Shell DUY NHẤT (anonymous): header + tablist + 4 `<section class="tab-panel">` + modal root + toast root + **section form token trong-page** (ẩn mặc định bằng `hidden`, hiện theo luồng §3) | `lang="vi"`, link `style.css`, defer `app.js`. Không thẻ script ngoài, KHÔNG inline script (CSP `script-src 'self'` — finding 9). **KHÔNG có token.html riêng** (quyết định hội đồng; nếu Backend giữ `/token.html`+`/token.js` exempt trong DESIGN thì vô hại nhưng UI v1 không dùng). |
| `style.css` | `:root` tokens (§8) → layout → component class theo BEM gọn (`.btn .btn--primary .badge .card .tbl…`) → class form token | Static serve **anonymous** nên form token dùng chung `style.css`, không lỗi thiếu style (finding 5). ~300–450 dòng, 0 dependency. |
| `app.js` | module đơn: state store, poll engine (§6.1), fetch helper (§6.3), router tab, renderer từng tab dạng hàm `renderDashboard(data)`…, modal/toast, token gate trong-page | Vanilla, không framework. External script duy nhất (CSP OK). Chia hàm theo tab để T12–T15 review dễ tách. |

**Anti-patterns cấm:** CDN, fetch font ngoài, `<script src>` bên ngoài, inline `style=` lẻ tẻ đặt giá trị số liên quan tới token (chỉ cho trường hợp đặc biệt như width %), code render dùng `innerHTML` cho dữ liệu không được sanitize (mọi URL/title từ RSS/history phải `textContent` hoặc escape — RSS title là dữ liệu lạ).

---

## 10. Checklist cho frontend (đối chiếu AC)

- [ ] Token gate: index.html onload gọi GET /api/status → 401 → form token trong-page (không navigation); verify qua POST /api/auth/verify; đúng → sessionStorage + vào app; sai → 401 + message; 429 kèm lockedUntil → countdown; reload cùng tab → token còn trong sessionStorage (quyết định hội đồng 2026-08-20).
- [ ] 4 tab chuyển không reload; không console error khi load.
- [ ] Start → RUNNING ≤3s; Stop → STOPPED ≤5s; nút disable đúng lúc chuyển trạng thái (PRD AC-2).
- [ ] Log: dòng mới ≤3s; filter Mọi/Lỗi/Bỏ qua; 1000 dòng cuộn mượt; xử lý `reset:true` (xoá log hiện tại, gán con trỏ theo `data.lastSeq`, render backlog); auto-scroll pause khi kéo lên / resume khi về đáy (PRD AC-3).
- [ ] Lịch sử: 5 field đủ; entry cũ render `—`; click mở link (protocol-validate http/https trước window.open); "Đăng thử" bị disable khi bot chạy HOẶC `lock.held`; dry-run preview; sau post bảng refresh (PRD AC-4).
- [ ] Config: secret chỉ `••••` + 3 trạng thái GIỮ/SỬA/XÓA; chỉ gửi `*_SET` khi user chủ động (không gửi khi GIỮ); không render giá trị secret (PRD AC-8); toast "áp dụng từ chu kỳ kế tiếp"; "Kiểm tra feed" ≥ 1 preview (PRD AC-6); community list role/canPost.
- [ ] OAuth: bấm "Kết nối Google" → giữ `const popup=window.open(consentUrl)` → tab chính poll thấy `auth.hasSession=true` hoặc `lastOAuthError!=null` → `popup.close()`; badge update ≤3s; lỗi 2FA/register hiển thị tiếng Việt từ `lastOAuthError` sanitized (PRD AC-7).
- [ ] Mất kết nối → banner + tự hồi phục; 401 → về token page.
- [ ] Không phụ thuộc mạng ngoài; không framework/build (PRD AC-10, NFR).

---

## 11. Decision log (hội đồng, 2026-08-20) — vá sau vòng phản biện chéo

**Quyết định chung làm nền (Backend vá theo — UI phải khớp)**: static (`index.html`/`app.js`/`style.css`) **ANONYMOUS, KHÔNG gate Bearer — chỉ gate `/api/*`**; `index.html` onload gọi `GET /api/status` → 401 → **form token trong-page (không navigation)**; token chỉ lưu **sessionStorage**. Toàn bộ mục sửa trong doc: §2.1, §3, §4.1–4.4, §5.4/§6.3, §9, §10.

| # | Finding | Quyết định | Lý do / Ghi chú áp vào doc |
|---|---|---|---|
| 1 | [Backend] major — log không xử lý `reset:true` (DESIGN §8.2) | **CHẤP NHẬN** | §4.2 thêm hàng "Reset con trỏ": `reset===true` → xoá log hiện tại, gán `lastSeq=data.lastSeq`, render backlog trả về. Tránh nuốt sạch log sau restart process / since lùi về trước cap. |
| 2 | [Backend] major — popup OAuth không tự đóng (CSP cấm inline JS trên `/callback` tĩnh) | **CHẤP NHẬN** | §4.1: tab chính giữ `const popup`; mỗi poll thấy `auth.hasSession=true` hoặc `lastOAuthError!=null` → `popup.close()`. Không dựa vào JS của trang `/callback`. |
| 3 | [Backend] major — "Đăng thử" bỏ qua `status.lock.held` → 2 writer posted.json | **CHẤP NHẬN** | §4.3: disable thêm khi `lock.held===true` + tooltip PID. Khớp T23/R15 (PM2 loop khác đang nắm lock). |
| 4 | [Backend] major — mâu thuẫn "bỏ trống + Lưu = giữ cũ" vs "xoá trắng = xoá secret" | **CHẤP NHẬN** | §4.4 chuyển sang 3 trạng thái GIỮ/SỬA/XÓA; **chỉ gửi `*_SET` khi user CHỦ ĐỘNG** (SỬA có giá trị / XÓA) — GIỮ không gửi field. Hết mâu thuẫn. |
| 5 | [Backend] minor — token page mất style.css bị gate | **TRỞ NÊN VÔ HIỆU với quyết định chung** | Static anonymous nên `style.css` load bình thường; đồng thời bỏ token.html riêng → form token nằm trong `index.html`, dùng chung style.css → hết hiện tượng thiếu style. Ghi §9. |
| 6 | [Backend] minor — verify bằng `GET /api/status` trái contract C1b | **CHẤP NHẬN** | §3: verify qua **`POST /api/auth/verify`** body `{token}` (exempt, trả 200/401). `GET /api/status` chỉ để phát hiện trạng thái authed lúc onload. |
| 7 | [Security] major — `window.open(link)` không validate protocol (link stored hostile) | **CHẤP NHẬN** | §4.3: `new URL(link)` + `protocol∈{http:,https:}` trước khi mở; lỗi/protocol lạ → không mở. Khớp THREAT C8.2 / T3. |
| 8 | [Security] minor — `lastOAuthError` nguyên bản | **CHẤP NHẬN** | §4.1: UI chỉ render `lastOAuthError` qua `textContent` như message tiếng Việt đã backend map/sanitize (DESIGN §8.13, T16.AC.3); field vắng → card lỗi chung; không render body lỗi thô. |
| 9 | [Security] minor — CSP `script-src 'self'` vs inline script token.html | **CHẤP NHẬN** | Bỏ token.html → form token trong `index.html` + `app.js` external (CSP thoả); không inline script bất kỳ đâu. §9. |
| 10 | [Backend UX] minor — token mất mỗi reload + auto-scroll log | **CHẤP NHẬN** | Token dùng **sessionStorage** (quyết định chung; §3). Log: **pause auto-scroll khi user kéo lên, resume khi về đáy**, badge đếm dòng mới (§4.2). |
| 11 | [Backend UX] minor — 429 thiếu countdown | **CHẤP NHẬN** | §3: 429 kèm `lockedUntil` → countdown "Thử lại sau Ns" + disable ô/nút; không có field → message chung. Lưu ý Backend bổ sung `lockedUntil` vào response verify khi vá DESIGN. |
| 12 | [Threat] minor — T10.AC.2 "static file cũng bị gate" sao với quyết định chung | **CHẤP NHẬN (đồng thuận đổi)** | Sitemap §2.1 + §9 ghi rõ: static anonymous, chỉ gate API. Bản DESIGN/T10.AC.2 sẽ được Backend vá; UI-SPEC đã phản ánh đúng trạng thái mới. |

**Hệ quả tài liệu**: KHÔNG sửa `DESIGN`/`THREAT-MODEL` (bài của Backend/Security Architect). Nếu Backend vẫn giữ `/token.html` + `/token.js` trong exempt list DESIGN §5.3 thì không phá contract — nhưng UI v1 dùng `index.html` làm điểm vào duy nhất.