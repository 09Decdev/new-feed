# Skill: cook (Core Implementation)

**Goal:** Implement features theo approved plan, tuân thủ nghiêm ngặt Hexagonal Architecture cua content-service.

## Execution Rule
- Kiem tra plan da ton tai va duoc approve. Neu chua co, yeu cau user chay `/ck:plan` truoc.
- Chi viet code theo cac pha duoc trai trong plan.

---

## 1. Hexagonal Architecture (Ports & Adapters)

### Luong du lieu
```
Request → Controller → Service (inject Port interface) → Port → Adapter → DB
                    ↘ Service (inject CacheService/KafkaProducer truc tiep) → Redis/Kafka
```

### Layer responsibilities
- **`src/application/ports/outbound/`**: 13 Port interfaces (`I{Entity}RepositoryPort`). Chi dinh nghia contract, KHONG chua implementation.
- **`src/application/ports/tokens.ts`**: 12 Symbol DI tokens cho Port injection.
- **`src/core/services/`**: 18 domain services. Logic nghiep vu cot loi. TUYET DOI KHONG chua `Req`, `Res` hay import tu infrastructure layer.
- **`src/infrastructure/driving-adapters/http-rest/controllers/`**: 15 controllers. Nhan request → Validate DTO → Goi Service → Tra response.
- **`src/infrastructure/driven-adapters/persistence/postgres/`**: 14 repository adapters (Prisma). Phai `implements` Port tuong ung. KHONG chua business logic.
- **`src/config/redis/cache.service.ts`**: CacheService — inject TRUC TIEP vao Service, KHONG qua Port.
- **`src/config/kafka/kafka.producer.ts`**: KafkaProducer — inject TRUC TIEP vao Service, KHONG qua Port.

---

## 2. DI Symbol Tokens — QUAN TRỌNG

content-service su dung **Symbol tokens**, KHONG phai string tokens.

### Import Pattern (BAT BUOC)
```typescript
import type { IPostRepositoryPort } from 'src/application/ports/outbound/post.repository.port';
import { IPostRepositoryPort as IPostRepositoryPortToken } from 'src/application/ports/tokens';

@Injectable()
export class PostService {
  constructor(
    @Inject(IPostRepositoryPortToken)
    private readonly repo: IPostRepositoryPort,
  ) {}
}
```

**Luu y:** Import `type` cho interface, import Symbol token voi alias `...Token` de tranh xung dot ten.

### Danh sach 12 Symbol tokens
| Token | Port Interface | Adapter |
|---|---|---|
| `IPostRepositoryPort` | `IPostRepositoryPort` | `PostRepositoryAdapter` |
| `ICommentRepositoryPort` | `ICommentRepositoryPort` | `CommentRepositoryAdapter` |
| `ILikeRepositoryPort` | `ILikeRepositoryPort` | `LikeRepositoryAdapter` |
| `IViewRepositoryPort` | `IViewRepositoryPort` | `ViewRepositoryAdapter` |
| `IEventRepositoryPort` | `IEventRepositoryPort` | `EventRepositoryAdapter` |
| `ITicketRepositoryPort` | `ITicketRepositoryPort` | `TicketRepositoryAdapter` |
| `ITicketTypeRepositoryPort` | `ITicketTypeRepositoryPort` | `TicketTypeRepositoryAdapter` |
| `IGiftRepositoryPort` | `IGiftRepositoryPort` | `GiftRepositoryAdapter` |
| `IAnalyticsRepositoryPort` | `IAnalyticsRepositoryPort` | `AnalyticsRepositoryAdapter` |
| `IAuditLogRepositoryPort` | `IAuditLogRepositoryPort` | `AuditLogRepositoryAdapter` |
| `IFileRepositoryPort` | `IFileRepositoryPort` | `FileRepositoryAdapter` |
| `ISavedPostRepositoryPort` | `ISavedPostRepositoryPort` | `SavedPostRepositoryAdapter` |
| `IHiddenUserRepositoryPort` | `IHiddenUserRepositoryPort` | `HiddenUserRepositoryAdapter` |

### RepositoryModule Pattern
```typescript
@Global()
@Module({
  providers: [
    PrismaService,
    PostRepositoryAdapter,
    { provide: IPostRepositoryPort, useExisting: PostRepositoryAdapter },
    // ... 12 adapters khac
  ],
  exports: [PrismaService, ...repositories],
})
export class RepositoryModule {}
```

Khi them repository moi: Tao Port → Them Symbol token → Tao Adapter → Dang ky trong RepositoryModule.

---

## 3. Authentication & Authorization

### JwtMiddleware (tat ca routes, KHONG phai Guard)
`JwtMiddleware` (`src/middleware/jwt.middleware.ts`) chay truoc moi request:
- Decode JWT (KHONG verify, chi decode) → inject `req.headers['x-user-id']`, `req.headers['x-user-email']`
- Neu da co `x-user-id` header (tu API Gateway), skip decode
- Day la middleware toan cuc, KHONG can `@UseGuards` trong controller

### Guards (chi dung khi can)
| Guard | File | Mechanism | Su dung cho |
|---|---|---|---|
| `ServiceTokenGuard` | `src/interceptors/service-token.guard.ts` | `x-service-token` header = `INTERNAL_SERVICE_TOKEN` env | Internal service-to-service |
| `AdminKeyGuard` | `src/interceptors/admin-key.guard.ts` | Verify JWT voi internal secret | Admin endpoints |

### Decorators
```typescript
@User() userId: string       // Lay tu req.headers['x-user-id']
@AuthToken() token: string   // Lay tu req.headers.authorization
```

---

## 4. Controller & DTO
- DTOs su dung `class-validator` va `@ApiProperty()` de sinh Swagger.
- Global `TransformResponseInterceptor` wrap tat ca responses.
- Controller chi nhan request, goi service, tra response. TUYET DOI KHONG viet logic.

### Service Layer Rules
- Service chi chua public methods ma Controller goi truc tiep.
- Private helpers chi duoc phep ton tai khi la logic noi bo don gian.
- Cross-service calls (InternalHttpService): viet thang vao method public, KHONG tach private method.
- Neu muon tach ham → PHAI viet trong `src/core/helper/` (PostHelper, ProfanityHelper), KHONG viet private method trong service.

---

## 5. Database & Prisma
- Schema tai `prisma/schema.prisma`.
- Import dung Prisma Client.
- Khi schema thay doi: `npx prisma generate` va `npx prisma migrate deploy`.

---

## 6. Kafka Architecture (Dual mode)

### In-process consumers
`@Controller()` + `@EventPattern('topic')` tu `@nestjs/microservices`. Dang ky trong feature module.

### Standalone Worker
`src/config/kafka/worker.ts` — chay doc lap cho high-throughput batch processing (likes). KHONG phai NestJS app.

### Producer
`KafkaProducer` tai `src/config/kafka/kafka.producer.ts` — file lon, 18+ publish methods. Dung `sendWithRetry()` voi exponential backoff.

### Dead-letter
Khi them consumer moi, PHAI implement DLQ: `kafkaProducer.send('content-service-dead-letter', { error, topic, payload, timestamp })`.

---

## 7. Internal Service Communication
- Dung `InternalHttpService` (`src/config/nginx/internalHttpService.ts`) de call sang service noi bo qua nginx proxy.
- TUYET DOI KHONG dung `axios` hay `HttpService` goc ma khong qua wrapper nay.

---

## 8. Exception Pattern — Day du

Tat ca custom exceptions **extend `HttpException` truc tiep**.

### Exceptions trong `src/core/exceptions/custom.exception.ts`
| Exception | HTTP Status | Error Code | Muc dich |
|---|---|---|---|
| `BusinessException` | 400 | `BUSINESS_LOGIC_ERROR` | Logic validation failure |
| `ResourceNotFoundException` | 404 | `RESOURCE_NOT_FOUND` | Resource khong ton tai |
| `ResourceNotFoundByException` | 404 | custom | Resource khong tim thay theo dieu kien |
| `UnauthorizedException` | 401 | - | Khong co quyen |
| `ForbiddenException` | 403 | - | Bi cam truy cap |
| `UserIdRequiredException` | 400 | - | Thieu user ID |
| `PostBlockedException` | - | 18 | Post bi block do moderation |
| `ProfanityContentException` | 400 | `INAPPROPRIATE_CONTENT` (40001) | Noi dung chua tu ngu khong phu hop, kem danh sach tu vi pham |

### Gift Exceptions trong `src/core/exceptions/gift.exceptions.ts`
```typescript
export class GiftException extends HttpException {
  constructor(message: string, errorCode: GiftErrorCode, statusCode?: HttpStatus)
}
```
`GiftErrorCode` enum: `GIFT_REFERRAL_CODE_IN_USE` (101), `GIFT_CAMPAIGN_NOT_FOUND` (102), `GIFT_CAMPAIGN_FULL` (103), `GIFT_OUT_OF_STOCK` (110), v.v.

### Cach su dung
```typescript
throw new ResourceNotFoundException('Post', postId);
throw new BusinessException('Du lieu khong hop le');
throw new GiftException('Het qua tang', GiftErrorCode.GIFT_OUT_OF_STOCK);
throw new ProfanityContentException(['word1', 'word2']);
```

### Response format
**Error** (`GlobalExceptionFilter`):
```json
{
  "success": false,
  "statusCode": 400,
  "message": "Mo ta loi",
  "error": "BUSINESS_LOGIC_ERROR",
  "timestamp": "2026-01-15T10:00:00.000Z",
  "path": "/content-service/posts",
  "traceId": "uuid-trace"
}
```

**Success** (`TransformResponseInterceptor`):
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Data retrieved successfully",
  "data": { ... },
  "metadata": { "page": 1, "limit": 10, "total": 100, "totalPages": 10 },
  "timestamp": "2026-01-15T10:00:00.000Z"
}
```

Trong `core/services`, **TUYET DOI KHONG** nem loi HTTP tho. Dung custom exceptions.

---

## 9. Content Moderation
- `ProfanityHelper` (`src/core/helper/profanity.helper.ts`): Vietnamese + English profanity filter (leo-profanity).
- `SafeBrowsingHelper` (`src/core/helper/safe_browsing.helper.ts`): Google Safe Browsing API.
- `ModerationStatus` enum: `ACTIVE`, `UNBANNED`, `SOFT_LOCKED`, `ADMIN_LOCKED`.

---

## 10. Redis Usage
- `CacheService` tai `src/config/redis/cache.service.ts` — file lon (non-NestJS class), inject TRUC TIEP, KHONG qua Port.
- Dung cho: counters (likes, comments, views), ticket stock (Lua scripts), rate limiting, distributed locks, dedup, saved post flags, enforcement cache.
- Lua scripts cho atomic operations (ticket stock, like dedup).

---

## 11. Naming Conventions
- File/Folder: `kebab-case.suffix.ts`
- Class: `PascalCase`
- Ham, Bien: `camelCase`

---

## 12. Khi them feature moi
1. Tao plan — Chay `/ck:plan` truoc khi viet code
2. Them Port interface — `src/application/ports/outbound/{entity}.repository.port.ts`
3. Them Symbol token — `src/application/ports/tokens.ts`
4. Tao Adapter — `src/infrastructure/driven-adapters/persistence/postgres/{entity}.repository.adapter.ts`
5. Dang ky trong RepositoryModule — Them vao providers array
6. Tao Service — `src/core/services/{entity}.service.ts` (inject qua Symbol token)
7. Tao Controller — `src/infrastructure/driving-adapters/http-rest/controllers/{entity}.controller.ts`
8. Tao Module — `src/modules/{entity}.module.ts`
9. Dang ky trong AppModule — Them vao imports
