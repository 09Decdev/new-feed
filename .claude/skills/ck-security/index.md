# Skill: ck-security (Security & Error Handling)

**Goal:** Audit codebase cho vulnerabilities, proper authorization, va structured error handling.

---

## 1. Authentication & Authorization

### JwtMiddleware (global middleware, KHONG phai Guard)
- `JwtMiddleware` (`src/middleware/jwt.middleware.ts`) chay truoc moi request.
- Decode JWT (KHONG verify) → inject `x-user-id`, `x-user-email` headers.
- Neu da co `x-user-id` (tu API Gateway), skip decode.
- Controllers KHONG tu decode JWT. Lay user info qua `@User()` decorator.

### Guards (dung theo muc dich)
| Guard | File | Mechanism | Dung cho |
|---|---|---|---|
| `ServiceTokenGuard` | `src/interceptors/service-token.guard.ts` | `x-service-token` header = env `INTERNAL_SERVICE_TOKEN` | Internal service-to-service endpoints |
| `AdminKeyGuard` | `src/interceptors/admin-key.guard.ts` | Verify JWT voi internal secret | Admin endpoints |

### KHONG TON TAI guard nao khac cho user auth. User identity lay qua `@User()` decorator (JwtMiddleware da inject headers).
### KHONG bao gio su dung guard khong ton tai nhu `MyjwtGuard`.

### Decorators
```typescript
@User() userId: string       // req.headers['x-user-id']
@AuthToken() token: string   // req.headers.authorization
```

### Audit task
- [ ] Check moi Controller Endpoint xem co dung Guard tuong ung khong.
- [ ] User endpoints: `@User()` decorator de lay userId (JwtMiddleware da xu ly).
- [ ] Admin endpoints: `@UseGuards(AdminKeyGuard)`.
- [ ] Internal service endpoints: `@UseGuards(ServiceTokenGuard)`.
- [ ] Public endpoints: Khong can Guard hoac decorator.

---

## 2. Error Handling (Cuc ky quan trong)

Trong `core/services`, **TUYET DOI KHONG** nem loi HTTP tho.

### BAT BUOC dung custom exceptions:

#### `src/core/exceptions/custom.exception.ts`
| Exception | HTTP Status | Error | Muc dich |
|---|---|---|---|
| `BusinessException` | 400 | `BUSINESS_LOGIC_ERROR` | Logic validation failure |
| `ResourceNotFoundException` | 404 | `RESOURCE_NOT_FOUND` | Resource khong ton tai |
| `ResourceNotFoundByException` | 404 | custom | Khong tim thay theo dieu kien |
| `UnauthorizedException` | 401 | - | Khong co quyen |
| `ForbiddenException` | 403 | - | Bi cam truy cap |
| `UserIdRequiredException` | 400 | - | Thieu user ID |
| `PostBlockedException` | - | 18 | Post bi block moderation |
| `ProfanityContentException` | 400 | `INAPPROPRIATE_CONTENT` (40001) | Noi dung khong phu hop |

#### `src/core/exceptions/gift.exceptions.ts`
- `GiftException(message, errorCode: GiftErrorCode, statusCode?)` — Gift-specific errors.
- `GiftErrorCode` enum: 101-110+ cho gift campaign, stock, referral errors.

### Response format
- `GlobalExceptionFilter` catch tat ca errors, format voi UUID `traceId`.
- Error response: `{ success: false, statusCode, message, error, timestamp, path, traceId }`.
- Success response: `{ success: true, statusCode, message, data, metadata, timestamp }`.

### Audit task
- [ ] Check cac khoi try-catch, dam bao moi ngoai le deu duoc map ve custom exceptions.
- [ ] Khong de lo stack trace 500 ra API public.
- [ ] Gift operations nem `GiftException` dung `GiftErrorCode`, KHONG nem `BusinessException` chung chung.

---

## 3. Content Safety
- **Profanity Filter**: `ProfanityHelper` (`src/core/helper/profanity.helper.ts`) filter Vietnamese + English offensive words. Nem `ProfanityContentException` voi danh sach tu vi pham.
- **URL Safety**: `SafeBrowsingHelper` (`src/core/helper/safe_browsing.helper.ts`) check URLs via Google Safe Browsing API.

---

## 4. OWASP & STRIDE Audit

### SQL/NoSQL Injection
- Prisma parameterized queries mac dinh bao ve SQL injection.
- NHUNG: Raw queries (`$queryRaw`, `$executeRaw`) PHAI dung parameterized inputs.
- Full-text search (`searchSmart`) dung `unaccent` + `websearch_to_tsquery` — verify parameterization.

### Data Leakage
- Response DTOs KHONG tra ve sensitive data (password hashes, internal tokens, JWT secrets).
- Premium content metadata KHONG expose cho non-purchasers.
- `UserUnlockedContent` chi tra ve cho user da mua.

### Rate Limiting
- Check rate limiting tren cac endpoint nhay cam: create post, comment, purchase ticket, gift claim.
- Ticket flash sale: Check Redis dedup va queue mechanism.

### File Upload
- Validate file type, size qua `file-upload.constant.ts` va `media-type.constant.ts`.
- MinIO presigned URLs phai co expiry ngan.
- Check `PendingFileDeletion` flow — file bi xoa tren MinIO sau khi archive.

---

## 5. Inter-Service Communication Security
- Internal API calls PHAI dung `InternalHttpService` voi proper headers (`x-service-token`).
- Kafka messages phai co proper serialization/deserialization.
- KHONG hardcode sensitive config — dung environment variables qua `@nestjs/config`.
- `INTERNAL_SERVICE_TOKEN` env var dung cho `ServiceTokenGuard`.
- JWT internal secret dung cho `AdminKeyGuard` va `jwt-internal.util.ts`.

---

## 6. Premium Content Security
- Presigned URLs phai co expiry ngan.
- Purchase verification phai check ca DB record (`UserUnlockedContent`) lan payment status.
- KHONG expose premium content metadata cho non-purchasers.
- `PremiumPostInfo` trang thai transitions: PENDING → APPROVED → ON_SALE → SOLD_OUT/EXPIRED/STOPPED. Chi ON_SALE cho phep mua.
- `PremiumPostAuditLog` ghi lai moi thay doi — verify audit trail khong bi tam.
- Payment flow: Kafka `payment_successful` → `PostController` → tao `UserUnlockedContent`. Verify event processing la idempotent.

---

## 7. Enforcement System Security
- Kafka `user.enforcement.changed` consumer phai validate message integrity.
- Enforcement state cache trong Redis (`enforcement:user:{userId}`) phai co TTL va fallback to DB.
- `ModerationStatus` transitions: chi ADMIN_LOCKED/SOFT_LOCKED co the bi enforcement trigger.
- `LIFTED` action phai restore dung trang thai truoc do (ACTIVE hoac UNBANNED).
- Dead-letter queue (`content-service-dead-letter`) cho failed enforcement events.
