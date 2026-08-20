# Skill: ck-debug (Root-Cause Diagnosis)

**Goal:** Dieu tra nguyen nhan goc re truoc khi sua bug. TUYET DOI KHONG SUA CODE "MO" (Guess-and-check).

When invoked with `/ck:debug <issue>`, you must:
1. Trace the call stack theo dung luong du lieu:
   - **DB access**: Controller → Service → Port → Repository Adapter (Prisma)
   - **Redis access**: Controller → Service → CacheService (inject truc tiep, KHONG qua Port)
   - **Kafka access**: Controller → Service → KafkaProducer (inject truc tiep, KHONG qua Port)
2. Formulate hypotheses about the cause.
3. Validate each hypothesis layer by layer.
4. Output a Diagnosis Report chua Root Cause.
5. Do not apply fixes until root cause is identified. Use `/ck:fix` to apply the patch.

---

## Trace Layers (Dung thu tu)

### Layer 1: Controller
- Kiem tra DTO validation, `@User()` / `@AuthToken()` decorator co extract dung khong.
- JwtMiddleware co inject `x-user-id` / `x-user-email` headers khong?
- Guard dung loai nao? `ServiceTokenGuard`? `AdminKeyGuard`? Hay khong can Guard?

### Layer 2: Service
- Kiem tra business logic, Port injection dung Symbol token alias.
- CacheService / KafkaProducer co inject truc tiep khong?
- Cross-service calls co dung `InternalHttpService` khong?

### Layer 3a: Repository Adapter (DB access via Port)
- Kiem tra Prisma query: `where`, `include`, `select`, `orderBy`.
- Check unique constraints, foreign keys, cascading deletes.
- Check `$transaction` cho multi-step operations.

### Layer 3b: CacheService (Redis access, inject TRUC TIEP)
- Kiem tra Redis key pattern dung khong.
- Check TTL: key co bi expire som khong?
- Check Lua script: atomic operation co dung khong?

### Layer 3c: KafkaProducer (Kafka access, inject TRUC TIEP)
- Kiem tra topic name co khop voi consumer khong.
- Check `sendWithRetry()` co duoc su dung khong.
- Check message format: serialization/deserialization.

---

## Common Bug Patterns (content-service)

### Redis Counter Desync
- **Symptom**: Like count tren Redis khong khop voi DB.
- **Root Cause**: Standalone Worker crash truoc khi flush batch, hoac Redis key expired truoc khi sync.
- **Diagnosis**: Check CacheService like counter keys (`post:{postId}:likes`, `post:{postId}:user:{userId}`), verify worker offset commit, check batch size (env `BATCH_SIZE` = 500).

### Kafka Event Lost
- **Symptom**: Event duoc publish nhung downstream service khong nhan duoc.
- **Root Cause**: Topic name mismatch giua producer va consumer, hoac consumer group rebalancing.
- **Diagnosis**: Verify topic name trong `KafkaProducer`, check consumer subscription, verify `sendWithRetry()` co retry khong.

### Premium Post Access Issue
- **Symptom**: User da purchase nhung khong xem duoc premium content.
- **Root Cause**: Purchase record khong duoc tao (Kafka `payment_successful` event lost), hoac `UserUnlockedContent` khong tao dung.
- **Diagnosis**: Check `PostController` payment consumer processing, verify `UserUnlockedContent` record trong DB, check `PremiumPostInfo` status.

### Ticket Stock Oversell
- **Symptom**: Sold count vuot qua total available tickets.
- **Root Cause**: Redis Lua script race condition, hoac TTL key expire giua reserve va confirm.
- **Diagnosis**: Check CacheService ticket stock Lua script (`ticket_stock:{ticketTypeId}`), verify atomic operations, check `user_pending_quota` TTL.

### Profanity False Positive
- **Symptom**: Legitimate content bi block boi profanity filter.
- **Root Cause**: Tu hop le trung voi blacklist entry, hoac config qua strict.
- **Diagnosis**: Check `ProfanityHelper` word list (Vietnamese + English), test voi sample input.

### Gift Campaign Issues
- **Symptom**: User khong nhan duoc qua tang, hoac nhan duoc qua trung lap.
- **Root Cause**: `GiftCampaignParticipant` dedup khong chay, hoac `GiftInventory` stock khong duoc check atomic.
- **Diagnosis**: Check `GiftService` claim logic, verify participant dedup, check `GiftErrorCode` exception flow.

### Enforcement Not Applied
- **Symptom**: User bi BANNED nhung van dang bai viet duoc.
- **Root Cause**: Kafka `user.enforcement.changed` event khong duoc nhan, hoac Redis enforcement cache expired.
- **Diagnosis**: Check `EnforcementConsumer`, verify Redis key `enforcement:user:{userId}`, check `ModerationStatus` SOFT_LOCKED transition.

### Comment Count Desync
- **Symptom**: Comment count hien thi khong dung.
- **Root Cause**: Redis `post:comment_count:{postId}` TTL (24h) expire va chua duoc refresh, hoac Kafka `post.comment.count` event khong duoc publish.
- **Diagnosis**: Check CacheService comment counter, verify CommentService publish event dung topic.

### Scheduled Post Not Publishing
- **Symptom**: Post da hen gio (`publishAt`) nhung khong duoc publish.
- **Root Cause**: PostService cron job khong chay, hoac `ScheduledPost` record bi loi trang thai.
- **Diagnosis**: Check PostService cron, verify `publishAt` timestamp, check `posts.event.now` Kafka event.

---

## Diagnosis Report Template

```markdown
# Diagnosis: [Issue Title]

## Symptom
[Mo ta hien tuong]

## Call Stack Trace
1. `Controller.method()` → nhan request
2. `Service.method()` → business logic
3. `[Port → Adapter | CacheService | KafkaProducer]` → data access
4. Ket qua tra ve / Exception nem ra

## Hypotheses
1. [Hypothesis 1] → [Validated: Yes/No, Evidence]
2. [Hypothesis 2] → [Validated: Yes/No, Evidence]

## Root Cause
[Mo ta nguyen nhan goc re]

## Suggested Fix
[Mo ta cach fix, KHONG implement — dung /ck:fix]

## Files Affected
- `path/to/file.ts:line` — [ly do]
```
