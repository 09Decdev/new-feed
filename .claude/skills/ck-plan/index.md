# Skill: ck-plan (Planning)

**Goal:** Force structured thinking va dependency detection truoc khi implement.

When invoked with `/ck:plan <description>`, you must:
1. Scout codebase de tim related files (Controllers, Services, Ports, Repository Adapters, Kafka Producers/Consumers, Redis CacheService).
2. Check existing implementations hoac shared utilities de tranh duplication.
3. Output `[feature_name]_plan.md` chua:
   - **Goal:** Mo ta ngan gon.
   - **Dependencies:** Files/services bi anh huong (Kafka topics, Prisma schema changes, Redis keys, Internal HTTP calls).
   - **Phases:** Step-by-step implementation list.
   - **Acceptance Criteria:** The nao la "done".
4. KHONG viet implementation code. Doi user approve plan.

---

## Architecture Rule: Service Boundaries (TU DONG AP DUNG)

Khi plan cho `content-service`, **TU DONG** xac dinh scope:

### Nghiep vu noi bo (CRUD Post, Comment, Like, Event, Ticket, Gift)
- Xu ly truc tiep qua Prisma + Redis cache.
- Chi sua Port + Service + Repository Adapter + Controller.
- Service inject Port interface qua Symbol token cho DB access.
- CacheService va KafkaProducer inject TRUC TIEP (KHONG qua Port).

### Nghiep vu can dong bo (content moderation, enforcement)
- BAT BUOC lang nghe Kafka event hoac call `InternalHttpService` sang service khac.
- Consumer moi PHAI implement DLQ + idempotency.

### Kafka Producer
- Khi can emit event, dung `KafkaProducer` da co. Topic names duoc define trong producer.
- Luon dung `sendWithRetry()` voi exponential backoff.

### Kafka Consumer
- Moi consumer moi phai implement DLQ + idempotency.
- Consumer patterns: `@EventPattern('topic')` trong Controller.

---

## Plan Template

```markdown
# [Feature Name] Plan

## Goal
[Brief description]

## Dependencies
- **Prisma models affected**: [list models]
- **Kafka topics**: [producer topics / consumer patterns]
- **Redis keys**: [affected cache keys]
- **Internal HTTP calls**: [calls to other services]
- **Port/Adapter changes**: [new ports or modified interfaces]

## Phases

### Phase 1: [Name]
- [Step detail]
- [File: path/to/file]

### Phase 2: [Name]
- [Step detail]

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
```

---

## Dependency Checklist (LUON check truoc khi plan)

### Database
- [ ] Prisma schema thay doi? → `npx prisma generate` + `npx prisma migrate deploy`
- [ ] New model? → Them Port + Symbol token + Adapter + RepositoryModule registration
- [ ] New enum? → `src/core/enum/` hoac `src/core/constant/`

### Kafka
- [ ] New producer topic? → Them method trong `KafkaProducer`
- [ ] New consumer? → `@EventPattern` + DLQ + idempotency
- [ ] Consumer trong NestJS hay Standalone Worker?

### Redis
- [ ] New cache key? → Dang ky key pattern trong CacheService
- [ ] Atomic operation? → Lua script
- [ ] TTL strategy?

### Auth
- [ ] Endpoint can xac thuc? → `@User()` decorator (JwtMiddleware da inject headers)
- [ ] Admin endpoint? → `@UseGuards(AdminKeyGuard)`
- [ ] Internal service endpoint? → `@UseGuards(ServiceTokenGuard)`

### Cross-service
- [ ] Call sang service khac? → `InternalHttpService` voi `x-service-token`
- [ ] Nhan event tu service khac? → Kafka consumer
