# Skill: ck-scenario (Edge Case Generation)

**Goal:** Tao edge cases across dimensions de phong bug truoc khi plan complex features. Dac biet tap trung vao content-service specific scenarios.

When invoked with `/ck:scenario <feature_description>`, output potential failure modes cho tat ca cac dimension duoi day.

---

## 1. Kafka Topic Failures

### Producer failures
- `KafkaProducer.sendWithRetry()` dat max retry nhung van fail → message bi mat. Consumer nao phu thuoc vao event nay se khong nhan duoc?
- Topic name mismatch: `posts.event` vs `posts.events` (typo) → message vao sai topic, consumer khong nhan.
- Message serialization loi: JSON payload chua undefined field, nested object qua lon.
- Partition key khong dong nhat: Cung post ma like events di khac partition → thu tu xu ly sai.

### Consumer failures
- `payment_successful` event bi mat hoac duplicate → `UserUnlockedContent` khong tao hoac tao trung lap.
- `user.enforcement.changed` event den khi service dang down → event bi skip (consumer offset da commit).
- `ticket_queue` event xu ly cham → queue bi tac, user doi qua lau.
- Consumer group rebalancing giua batch processing → offset commit sai.
- Dead-letter queue (`content-service-dead-letter`) bi day → message bi mat hoan toan.

### Standalone Like Worker failures
- Worker crash giua batch (500 items) → offset chua commit, batch xu ly lai tu dau. NHUNG da co Redis dedup (SET NX TTL 24h) cho eventId.
- Redis connection mat giua dedup check → duplicate likes vao DB.
- Prisma `$transaction` timeout cho `createMany`/`deleteMany` voi batch lon.
- Signal handling: SIGTERM den khi dang giua transaction → partial commit.

---

## 2. Redis Key & Cache Failures

### Counter desync
- `post:{postId}:likes` Redis counter khong khop voi `PostLike` DB table → hien thi sai so like.
- `post:comment_count:{postId}` TTL 24h expire → count tra ve 0 cho den khi refresh.
- `post:view:{postId}` pending views khong duoc flush (AnalyticsCronService chua chay) → view count sai.
- `user:{userId}:viewed_posts` Sorted set qua 1000 entries → posts cu bi loai bo khoi viewed list.

### Ticket stock race conditions
- Hai user cung reserve ticket cung luc → Redis Lua script phai handle atomic.
- `ticket_stock:{ticketTypeId}` hash bi corrupt → sold > total.
- `user_pending_quota:{userId}:{ticketTypeId}` TTL expire truoc khi confirm → user mat quota tam thoi, nhung DB van giu reservation.
- `ticket_gate_status:{ticketTypeId}` bi set CLOSED nhung co user dang trong queue → hang cho bi loi.

### Distributed lock issues
- `acquireLock()` thanh cong nhung process crash truoc `releaseLock()` → lock bi giu cho den TTL expire.
- Lock TTL qua ngan cho operation dai → lock tu expire giua chuong trinh, cho phep concurrent access.
- Lock key khong duy nhat giua cac operation → xung dot lock.

### Enforcement cache
- `enforcement:user:{userId}` cache expired giua request → user bi BANNED nhung van dang bai thanh cong.
- Cache tra ve stale data sau khi `LIFTED` event → user van bi han che du da duoc go.

---

## 3. Premium Post Lifecycle Edge Cases

### Status transitions
- Post PENDING duoc approve (APPROVED) nhung author xoa post truoc khi ON_SALE → orphan PremiumPostInfo.
- Post ON_SALE nhung author sua price → purchaser cu tra gia cu, purchaser moi tra gia moi. Race condition?
- SOLD_OUT (soldCount >= saleLimit) nhung co refund → soldCount giam, phai chuyen lai ON_SALE?
- EXPIRED nhung van co pending payment → user thanh toan cho post da het han.
- Admin REJECT post nhung post da co purchaser → refund flow?

### Payment & Unlock
- `payment_successful` event nhan 2 lan (duplicate) → tao 2 `UserUnlockedContent` record.
- `payment_failed` event nhung `UserUnlockedContent` da duoc tao → user thay noi dung premium mien phi.
- User mo khoa premium content tren device A, nhung device B chua sync → presigned URL expired.
- Premium post bi ADMIN_LOCKED sau khi user da mua → user da tra tien nhung khong xem duoc.

### Review system
- User viet review (rating 1-5) cho premium post chua mua → phai block.
- User sua review lan 2 (editCount > 1) → phai tu choi.
- Review xoa nhung rating average khong duoc recalculate.

### Audit log
- `PremiumPostAuditLog` snapshot thi dau thieu truong (preview title, price, media count) → audit khong day du.

---

## 4. Gift System Edge Cases

### Campaign lifecycle
- `GiftCampaign` het han (endDate) nhung cron chua chay → van cho phep claim.
- Campaign FULL nhung `GiftInventory` van con available → race condition giua participant count va stock.
- Admin tao campaign voi stock = 0 → claim luon fail.
- Campaign da het han nhung Kafka `gift.claim.requested` van trong queue → process claim cu.

### Stock & Inventory
- Hai user cung claim gift cung luc → `GiftCampaignParticipant` dedup (unique constraint) save, NHUNG `GiftInventory` stock giam 2 lan.
- `GiftInventory` ticketCode khong unique → duplicate gift distribution.
- Gift referral code trung (GiftErrorCode `GIFT_REFERRAL_CODE_IN_USE`) → phai generate lai.

### Notification
- `gift.notification.batch` event gui nhung notification-service down → user khong nhan duoc thong bao nhung gift da duoc claim.
- Batch notification qua lon → Kafka message size vuot gioi han.

---

## 5. Enforcement System Edge Cases

### Level transitions
- User dang RESTRICTED nhung nhan them event SUSPENDED → co tang cap dung khong?
- User BANNED nhung nhan event WARNED (level thap hon) → co giu BANNED hay ha xuong WARNED?
- LIFTED event nhung user khong co trang thai enforcement nao → ignore hay error?
- Enforcement event den khi cron dang soft-lock posts → concurrent modification.

### Moderation status
- Post dang ADMIN_LOCKED nhung enforcement LIFTED → post co duoc restore khong? (Chi SOFT_LOCKED duoc restore, ADMIN_LOCKED thi khong).
- User co nhieu posts, enforcement SUSPENDED → tat ca posts bi SOFT_LOCKED. Neu unlock tung post thi sao?

### Dead-letter
- Enforcement event bi gui vao DLQ nhung khong co mechanism reprocess → user bi BANNED vinh vien.

---

## 6. Cron Jobs & Scheduled Tasks

### Scheduled posts
- `publishAt` timestamp trong qua khu (do clock drift hoac delayed insert) → cron bo qua post nay mai mai.
- Cron chay luc 2 post cung `publishAt` → race condition trong update.
- Post duoc schedule nhung bi xoa truoc khi publish → cron thu publish post da xoa.

### View flush
- `AnalyticsCronService` flush pending views tu Redis (`post:view:{postId}`) nhung DB connection timeout → views bi mat.
- Flush interval qua dai → Redis memory tang cao do tich luy pending views.

### Gift campaign expiry
- `GiftCronService` xu ly campaign het han nhung con pending claims → claims bi huy nguoi dung khong nhan duoc qua.

### Archive purge
- PostArchive cu hon 2 nam bi xoa nhung file tren MinIO chua duoc xoa → leaked storage.
- CommentArchive purge nhung comment van duoc reference trong notification → broken reference.

---

## 7. Full-text Search Edge Cases

### Query issues
- `searchSmart()` voi empty string → tra ve tat ca posts hoac loi.
- `unaccent` function khong xu ly dung Unicode Vietnamese (dấu, ký tự đặc biệt) → ket qua tim kiem sai.
- `websearch_to_tsquery` voi special characters (`AND`, `OR`, `-`, `"`) → query khong mong muon.
- Search tren post co content rat lon (> 1MB) → performance issue.

### Index & Relevance
- Full-text search index khong duoc update sau khi post sua → ket qua cu.
- Relevance sorting vs recent sorting conflict → ket qua khong phan anh dung.
- Loai bo viewed posts nhung user khong dang nhap (no `x-user-id`) → viewed_posts set rong, khong loai duoc gi.

---

## 8. Prisma Constraints & Data Integrity

### Unique constraints
- `PostLike` unique (postId + userId) → user like 2 lan cung post. Retry khi da like → duplicate key error.
- `CommentLike` unique (commentId + userId) → tuong tu PostLike.
- `SavedPost` unique (postId + userId) → user save post da luu → duplicate.
- `Ticket` ticketCode unique → generate duplicate code → error.

### Foreign key constraints
- Comment `parentId` tham chieu den comment da bi xoa → orphan reply.
- `PostHashtag` tham chieu den Hashtag da xoa → constraint violation.
- `Media` tham chieu den Post da xoa → file bi ma, khong co post nao link.

### Soft delete vs Hard delete
- Post bi SOFT_LOCKED (enforcement) nhung user van co the tao comment moi cho post do.
- Hard delete post (`post.deleted` Kafka event) nhung `CommentArchive` chua duoc tao → mat du lieu vinh vien.
- `PendingFileDeletion` cho file tren MinIO nhung MinIO khong available → file bi treo, khong xoa duoc.

### Transaction issues
- `$transaction` cho ticket purchase (create Ticket + update stock + update cache) → partial fail.
- Nested transaction hoac transaction trong vong lap → deadlock.
- Prisma connection pool exhausted → timeout.

---

## 9. Profanity Filter Edge Cases

### False positives
- Tu hop le trung voi blacklist: "hoc" chua trong tu "d*hoc" (teencode) → block sai.
- Noi dung tieng Viet khong dau ("ngu") trung voi tu cam ("ng*") → false positive.
- URL hoac code snippet chua tu cam → block technical content.

### False negatives
- User bypass filter bang unicode tricks: "d i t m e" (spaces), "đ.ị.t" (dots), "𝖉𝖎𝖙𝖒𝖊" (math symbols).
- Mixed language bypass: Vietnamese bad words written in English pronunciation.
- Zero-width characters giua tu → filter khong nhan dien.

### Performance
- Profanity check tren post content rat lon (> 100KB) → response time tang dot ngot.
- `ProfanityHelper` check tung comment trong batch cao diem → CPU spike.

### Safe Browsing API
- Google Safe Browsing API down → URL check fail. Fallback cho qua hay block?
- URL chua redirect (bit.ly, short links) → Safe Browsing check URL goc hay URL redirect?
- Rate limit cua Google API → check fail cho hang loat URLs.

---

## 10. Concurrency & Race Conditions

### Like/Unlike race
- User like va nhanh unlike lien tuc → Kafka events `likes.post` gui nhieu, worker batch xu ly nhieu, ket qua cuoi khong xac dinh.
- Like count tren Redis tang giam lien tuc → counter drift.

### Ticket flash sale
- 10,000 users cung dat 100 tickets → Redis Lua script xu ly 10,000 requests trong vai giay.
- Queue position (`ticket_queue_pos:{ticketTypeId}`) overflow → counter reset.
- Reservation expires (`expiresAt`) nhung cron chua clean up → stock bi hold gia.

### Comment on deleted post
- User A dang viet comment, User B xoa post cung luc → comment duoc tao cho post khong ton tai.

### Concurrent post update
- Author va admin cung sua post → last-write-wins, du lieu bi mat.

---

## 11. Input Extremes & Malformed Data

### Oversized content
- Post content > max allowed length → DB error hoac Prisma validation fail.
- Comment qua dai → truncate hay reject?
- Hashtag qua nhieu (> 100) → performance issue trong search va indexing.

### Invalid media
- Media URL khong hop le (broken URL, non-image URL cho image field) → presigned URL fail.
- Media type khong ho tro (webp, avif, svg) → upload reject hay accept?
- File upload vuot size limit → `file-upload.constant.ts` validation.

### Malformed Kafka events
- `payment_successful` event thieu field (postId, userId, amount) → consumer crash.
- `user.enforcement.changed` event co action khong hop le (khong nam trong `EnforcementAction` enum) → consumer crash.
- Event voi timestamp trong tuong lai hoac qua khu → cron nhay cam xu ly.

---

## 12. Inter-Service Communication Failures

### InternalHttpService
- Target service down (payment-service, user-service) → timeout, retry strategy?
- `x-service-token` expired hoac invalid → 401 response, nhung goi lai khong co token moi.
- Nginx proxy timeout → request bi mat, service khong bai trade idempotency.

### Consul service discovery
- Consul registration fail → service khong duoc discover boi other services.
- Health check endpoint (`/health`) fail → Consul danh dau service unhealthy, traffic khong den.
- Multiple instances cung register voi cung service name → load balancing issue.

### Cascade failures
- payment-service down → premium post purchase fail, user khong mo khoa duoc content.
- notification-service down → gift notifications (`gift.notification.batch`) bi mat.
- user-service down → enforcement events khong duoc gui, user vi pham khong bi xu ly.
