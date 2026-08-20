# AUTOBUILD — news-poster GUI (nhật ký chạy)

> Log vận hành pipeline /autobuild. Cập nhật tăng dần theo từng wave/gate.
> Trạng thái cuối: **ĐANG CHẠY — Phase 3 Wave 2 (producer đang fix vòng 1)**

## 1. Yêu cầu khách hàng
"Làm 1 trang giao diện, trực quan — hiện tại khởi động tool phải dùng terminal, không trực quan."

## 2. Các cổng người (GATES)
| Cổng | Nội dung | Trạng thái |
|---|---|---|
| GATE 1 | PRD-news-poster-gui.md v0.2 | ✅ DUYỆT (quyết định: 1 feed; mở 0.0.0.0 + token; config áp chu kỳ kế tiếp) |
| GATE 2 | PLAN-news-poster-gui.md | ✅ DUYỆT (quyết định: FAIL không retry; OAuth embedded /callback 8899) |
| GATE 3 | Canary 1%→10%→50%→100% + merge | ⏳ chờ sau Phase 5 |

## 3. Quyết định thiết kế đã chốt (xem PRD/PLAN/DESIGN/UI-SPEC/THREAT-MODEL decision log)
- Server nhúng `node:http`, 1 process, 0 npm dep mới, vanilla JS không build/CDN.
- GUI_HOST/GUI_PORT/GUI_TOKEN từ .env; non-loopback bắt buộc token.
- Static ANONYMOUS, chỉ gate `/api/*`; token form in-page (tránh deadlock).
- Bearer sha256+timingSafeEqual; cross-site guard (Sec-Fetch-Site/Origin) no-token mode.
- Fail-auth per-IP backoff 429+lockedUntil.
- OAuth: /callback nhúng trên GUI_PORT, state single-use + TTL, Bearer exempt.
- FAIL items KHÔNG retry; dryRun preview KHÔNG LLM (dùng /api/rss-preview).
- SSRF guard safe-fetch (P0 loop + LLM redirect manual + LLM_BASE_URL https/public check).

## 4. Tiến độ phase
| Phase | Wave | Nội dung | Trạng thái |
|---|---|---|---|
| 0-2 | — | PRD / PLAN / Design council | ✅ |
| 3 | Wave 1 | Core backend T1-T4: BotController state machine, config-store, dedup, sanitize, safe-fetch, atomic writes, modeWeb khung | ✅ Reality Checker CHẤP-NHẬN (điều kiện: baseline git + xác nhận dev-host HTTP LLM_BASE_URL) |
| 3 | Wave 2 | Server+API T5-T10, T22-T24: log ring, router, Bearer, rate-limit, cross-site, /api/* endpoints | 🔄 vibe chống: critics R1 xong → producer fix R1 |
| 3 | Wave 3 | Frontend T11-T15 (4 tab, token form, poll 2s) | ⏳ |
| 3 | Wave 4 | OAuth T16-T17 (Google Console redirect_uri export) | ⏳ |
| 3 | Wave 5 | Test T18-T21 + ASSURANCE + mutate-test + canary | ⏳ |
| 4 | — | Hội đồng phản biện toàn feature | ⏳ |
| 5 | — | Synthesize + GATE 3 | ⏳ |

## 5. Vòng phản biện (findings còn SỐNG — adversarial verify)

### Wave 2 — Critics round 1 (lens: Code Reviewer / AppSec / Perf)
Critics: a4261fc1 (correctness), af41fbd6 (security), aedd14fc (perf).

**Còn sống — producer đang fix (1 blocker + 7 major + 3 medium + 2 perf):**
| ID | Mức | Tóm tắt |
|---|---|---|
| B1 | BLOCKER | Bootstrap gate chỉ chặn `0.0.0.0` thiếu token; LAN IP non-loopback (192.168.x.y) bind thiếu token → admin ẩn danh toàn LAN (G10) |
| M2 | MAJOR | Cross-site/host-check lỏng: chỉ isLoopbackHost(origin.hostname) bỏ qua port; hostcheck dùng DNS lookup thay so chuỗi loopback |
| M3 | MAJOR | Stop khi STARTING trả 400 (spec: STARTING→STOPPING) |
| M4 | MAJOR | /api/history trả data.items, spec data.entries |
| M5 | MAJOR | /api/logs?filter=all dùng includes('all') trả gần rỗng |
| M6 | MAJOR | /api/auth/verify không nhận Authorization header + envelope shape sai |
| M7 | MAJOR | Start pre-flight fail trả 200+ERROR thay 502 FORBIDDEN retryable |
| M8 | MAJOR | POST /api/config không gọi swapConfig → status.config lệch |
| M9 | MEDIUM | 415 ngoài bộ error code chuẩn → map 400 |
| M10 | MEDIUM | Fail-auth map per-IP không evict → leak khi bind remote |
| M11 | MEDIUM | dryRun rss cap 50×30s có thể kẹt hàng chục phút → cap dryRun |
| P1 | PERF | computeSecrets() readFileSync mỗi poll 2s → memoize theo mtime |
| P2 | PERF | ring không cap byte (dry-run content 5-20KB × 1000 → hàng chục MB) |

**Bị bác / chấp nhận:** ring shift O(n) (micro), sleepSync 50-200ms hiếm (ghi risk), 401-flood other-port = hệ quả M2 sẽ được chặn.

### Wave 1 — vòng 1 và 2 (đã fix, tường thuật còn lưu trong transcript):
- llm.client.ts redirect 'manual' (x-api-key leak qua 302 — fix).
- LLM_BASE_URL http→https + per-cycle async DNS guard TTL.
- swapConfig clearedSecretsSink (secret đã xóa không resurrect).
- postedToday midnight reset + seed.
- config-store Object.keys(Map) bug → changes.keys().
- releaseLoopLock TRƯỚC setState('STOPPED') (race self-lock).

## 6. HARD-GATE status
| GATE | Mô tả | Trạng thái |
|---|---|---|
| G1 | Tests xanh 0 skip (node:test — Wave 5) | ⏳ Wave 5 |
| G2 | Mutation ≥ ngưỡng | ⏳ Wave 5 |
| G3 | Contract test | ⏳ Wave 5 |
| G4 | Type/Lint/Build — tsc clean | ◐ smoke qua; chốt khi Wave 5 |
| G5 | SAST + secret-scan | ◐ code pass; scan cuối Wave 5 |
| G6 | Code Reviewer PASS (0 blocker/major) | ⏳ sau producer fix R1 |
| G7 | Reality Checker PASS | ◐ Wave 1 chấp nhận; chờ Wave 2 |
| G8 | Migration — no DB | ✅ N/A |
| G9 | Tiền | ✅ N/A |
| G10 | Auth/PII (non-loopback→token, cross-site, authz) | 🔄 chờ B1/M2 fix |

## 7. Lưu ý / mở
- Wave 1 RC condition: tạo git baseline + xác nhận dev-host HTTP LLM_BASE_URL (trong code: http chỉ allowlist dev mạng nội bộ — chờ xác nhận khách có chủ ý).
- Artifact test POST /api/post đã tạo 1 bài "demo" thật ở community (gateway dev).
- Chưa commit gì; nhánh feat/news-poster-gui.