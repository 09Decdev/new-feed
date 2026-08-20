# Skill: ck-review (Gatekeeper / AI Code Review)

**Goal:** Ra soat lai code vua sinh ra truoc khi merge/commit. Tra loi "Co/Khong/Da sua" cho cac muc sau:

---

## 1. Functional & Workflow
- [ ] Logic End-to-End co thong suong khong?
- [ ] Cac class/ham o Service co code logic that hay bi "ao gian" chi tra ve `return true;` / mock data?
- [ ] Da xu ly cac Edge case: DB tra ve rong, Kafka producer fail, Redis timeout chua?
- [ ] Premium post lifecycle: PENDING → APPROVED → ON_SALE → SOLD_OUT/EXPIRED/STOPPED. Co dung trang thai khong?
- [ ] Gift system: Stock check, campaign expiry, participant dedup. Da xu ly day du chua?

## 2. Architecture & Code Quality
- [ ] Co vi pham Hexagonal Architecture khong? (VD: Goi Prisma truc tiep tu Controller).
- [ ] Repository Port da duoc bind voi Adapter trong `RepositoryModule` chua?
- [ ] Service co import tu infrastructure layer khong? → PHAI inject qua Port interface + Symbol token.
- [ ] CacheService va KafkaProducer co duoc inject truc tiep (dung) hay qua Port (sai)?
- [ ] Khi call API sang service khac co dang su dung dung `InternalHttpService` khong?
- [ ] Code co lap lai (WET) thay vi dung utils chung khong?
- [ ] Naming convention (camelCase, PascalCase, kebab-case files) co dung chuan khong?
- [ ] DI import pattern dung: `import type` cho Port interface, `import { Token as TokenAlias }` cho Symbol token?

## 3. Security & Error Handling
- [ ] Endpoint can user identity co dung `@User()` decorator khong? (JwtMiddleware da inject headers truoc).
- [ ] Admin endpoint co dung `@UseGuards(AdminKeyGuard)` khong?
- [ ] Internal service endpoint co dung `@UseGuards(ServiceTokenGuard)` khong?
- [ ] KHONG su dung guard khong ton tai (nhu `MyjwtGuard`). Auth la JwtMiddleware + decorators.
- [ ] Cac Error co duoc catch va nem ra bang custom exceptions khong?
  - `BusinessException` cho logic validation
  - `ResourceNotFoundException` cho resource khong ton tai
  - `GiftException` cho gift-related errors
  - `ProfanityContentException` cho noi dung khong phu hop
  - `PostBlockedException` cho post bi block
- [ ] `GlobalExceptionFilter` co catch tat ca errors voi `traceId` khong?
- [ ] Khong duoc de lo stack trace 500 ra API public.

## 4. Performance & Reliability
- [ ] Co N+1 Query trong vong lap khi query Prisma khong?
- [ ] Redis cache co duoc su dung dung cho read-heavy/counters khong?
- [ ] Kafka producer co dung `sendWithRetry()` khong?
- [ ] Kafka consumer moi co implement DLQ + idempotency chua?
- [ ] High-throughput operations (likes, views) co dung batch processing khong?
- [ ] Ticket stock operations co dung Redis Lua scripts cho atomicity khong?

## 5. Content Moderation
- [ ] User-generated content co di qua profanity filter (`ProfanityHelper`) khong?
- [ ] URLs trong content co duoc check qua Safe Browsing (`SafeBrowsingHelper`) khong?
- [ ] ModerationStatus transition co dung business rules khong? (ACTIVE, UNBANNED, SOFT_LOCKED, ADMIN_LOCKED)

## 6. Data Integrity
- [ ] Like counter: Redis va DB co sync mechanism khong? (Standalone Worker batch processing)
- [ ] View counter: Co cron flush tu Redis vao DB khong? (`AnalyticsCronService`)
- [ ] Ticket stock: Redis hash va DB co consistent khong?
- [ ] Saved post flags: Redis key va DB record co dong bo khong?

## 7. Response Format
- [ ] Success response co dung format `{ success, statusCode, message, data, metadata, timestamp }` khong?
- [ ] Error response co dung format `{ success: false, statusCode, message, error, timestamp, path, traceId }` khong?
- [ ] DTO co dung `class-validator` + `@ApiProperty()` cho Swagger khong?
