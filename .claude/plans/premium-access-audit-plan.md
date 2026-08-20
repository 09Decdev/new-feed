# Plan: Sửa permission access cho các GET API liên quan Post

## 1. Mục tiêu

Sửa **quyền truy cập nội dung bài trả phí** cho các API `GET` liên quan đến post đang được dùng. Cứ API get post là phải check đủ 5 quyền: author, OWNER, POST_CONTENT, đã mua, bài không cần khóa.

API chuẩn tham chiếu: [post.controller.ts:120](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L120) `GET /post/premium-posts`.

---

## 2. Rule access đã confirm

User được xem full `content` thật và `media` thật nếu thỏa **một trong**:

1. Là **tác giả bài viết**.
2. Là **OWNER** của community.
3. Có quyền **POST_CONTENT** trong community.
4. **Đã mua / unlock bài premium**.
5. Bài không phải premium hoặc premium chưa cần khóa.

Nếu không pass: `hasAccess=false`, `content=''`, `media=[]`, vẫn trả preview fields.

---

## 3. Danh sách API cần sửa

### 3.1. `GET /post/getPostByCommunityId`

Controller: [post.controller.ts:283-299](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L283-L299)
Service: [post.service.ts:787-813](src/core/services/post.service.ts#L787-L813)
Repository: [post.repository.adapter.ts:840-861](src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L840-L861)

Vấn đề: Gọi `processPostList(posts, authorId, authHeader)` không truyền `isManager`, nên mặc định `false`. OWNER/POST_CONTENT bị che content/media.

#### Đặc thù khó

API này lấy posts từ **nhiều community**:

```ts
const listCommunityIds = await this.helper.fetchApprovedCommunityIds(authHeader);
```

Mỗi post có thể thuộc community khác nhau. Không thể truyền một boolean `isManager` chung.

#### Hai phương án tối ưu

**Phương án A: Batch permission theo unique communityIds trong page**

Lấy danh sách unique `communityId` từ kết quả page, gọi `fetchMemberPermission` cho từng unique community, build map:

```ts
const uniqueCommunityIds = [...new Set(posts.map((p) => p.communityId))];

const communityPrivilegeMap = new Map<string, boolean>();
await Promise.all(
  uniqueCommunityIds.map(async (cid) => {
    try {
      const perm = await this.helper.fetchMemberPermission(cid, authHeader);
      communityPrivilegeMap.set(cid, this.helper.hasManagerPermission(perm));
    } catch {
      communityPrivilegeMap.set(cid, false);
    }
  }),
);
```

Sau đó truyền map vào `processPostList()` thay vì boolean đơn. Trong `processPostList()`, với mỗi post:

```ts
const hasCommunityPostPrivilege = communityPrivilegeMap.get(post.communityId) ?? false;
const hasAccess = this.helper.checkPostAccessSync(
  post, currentUserId, unlockedPostIdSet, hasCommunityPostPrivilege,
);
```

- **Ưu:** Chính xác theo từng community, không sót quyền.
- **Nhược:** Thêm N external calls (N = số unique community trong page, thường 1-5).

**Phương án B: Sửa `processPostList()` nhận map thay vì boolean**

Đổi chữ ký:

```ts
processPostList(
  rawPosts, currentUserId, authHeader,
  privilegeMap: Map<string, boolean> | boolean = false,
)
```

- Nếu truyền `boolean` (cũ): hoạt động như cũ, backward compatible.
- Nếu truyền `Map`: lấy quyền theo `post.communityId`.

- **Ưu:** Backward compatible với các API cũ, chỉ cần thêm map cho `getPostByCommunityId`.
- **Nhược:** Chữ ký phức tạp hơn một chút.

**Đề xuất: Phương án A.**

Sửa chữ ký `processPostList` thêm param `privilegeMap` kiểu `Map<string, boolean>`. Nếu không truyền thì fallback về `false` như cũ. Các API cũ không bị ảnh hưởng.

---

### 3.2. `GET /post/AppointmentBookingArticle/:communityId`

Controller: [post.controller.ts:275-280](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L275-L280)
Service: [post.service.ts:1080-1084](src/core/services/post.service.ts#L1080-L1084)
Repository: [post.repository.adapter.ts:1047-1057](src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L1047-L1057)

#### Bug 1: Logic tìm kiếm sai

Hiện tại:

```ts
where: {
  communityId,
  isPublished: false,
}
```

Chỉ check `isPublished: false`. Nhưng theo nghiệp vụ cần thêm `publishedAt` phải khác null. Nếu `publishedAt` null thì bài chưa từng được publish (có thể là draft mới), không nên trả về.

Sửa thành:

```ts
where: {
  communityId,
  isPublished: false,
  publishedAt: { not: null },
}
```

#### Bug 2: Không check quyền access

Hiện tại:

```ts
return posts.map((post) => new PostResponseDto(post));
```

`PostResponseDto` default `hasAccess=true`. Premium content bị trả full mà không check 5 quyền.

Cần sửa: thêm user context (`@User('id')`, `@AuthToken()`) vào controller, check access theo 5 quyền, truyền `hasAccess` vào DTO.

Vì API này chỉ có một `communityId`, nên check `OWNER/POST_CONTENT` đơn giản:

```ts
const permissionData = await this.helper.fetchMemberPermission(communityId, authHeader);
const hasCommunityPostPrivilege = this.helper.hasManagerPermission(permissionData);
```

---

### 3.3. `GET /post/hashtag`

Controller: [post.controller.ts:354-368](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L354-L368)
Service: [post.service.ts:1433-1481](src/core/services/post.service.ts#L1433-L1481)

Vấn đề: Hardcode `isManager=false` ở [post.service.ts:1470](src/core/services/post.service.ts#L1470).

API có `communityId`, nên thêm `@AuthToken()` vào controller, truyền `authHeader` vào service, check `OWNER/POST_CONTENT` một lần cho community đó.

---

### 3.4. `GET /post/search`

Controller: [post.controller.ts:385-426](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L385-L426)
Service: [post.service.ts:996-1042](src/core/services/post.service.ts#L996-L1042)

Vấn đề: Trả `content` thật từ search, không qua `hasAccess`.

Cần bổ sung: thêm field `isPremium`, `premiumInfo` vào select của `searchSmart()`, sau đó strip `content` theo `hasAccess` ở service.

Với OWNER/POST_CONTENT: search có thể trả posts từ nhiều community, nên cũng cần privilege map như `getPostByCommunityId`. Tuy nhiên search trả `SearchResult[]` không phải DTO phức tạp, nên strip `content` khi `isPremium && !hasAccess` là đủ.

---

### 3.5. `GET /post/hiddenPost/:communityId`

Controller: [post.controller.ts:245-254](src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L245-L254)
Service: [post.service.ts:1182-1197](src/core/services/post.service.ts#L1182-L1197)

Permission đã OK vì đã `ensureUserHasPermission()`. Chỉ cleanup:

```ts
// Trước
return posts.map((post) => new PostResponseDto(post));
// Sau
return posts.map((post) => new PostResponseDto(post, true));
```

---

## 4. API không cần sửa

| API | Lý do |
|---|---|
| `GET /post/getAll` | User confirm không dùng, bỏ qua |
| `GET /post/premium-posts` | Mẫu chuẩn permission |
| `GET /post/purchased-posts` | Chỉ trả bài đã mua |
| `GET /post/communityId/:communityId` | Đã check OWNER/POST_CONTENT |
| `GET /post/:id` | Đã check đủ |
| `GET /post/postForNotification/:id` | Đã check đủ |
| `GET /post/postForUpdateAndDelete/:id` | Đã check đủ |
| `GET /post/my-posts` | Bài của chính user, author rule pass |
| `GET /post/infoForPurchase/:id` | Chỉ trả preview |
| `GET /post/trending-discovery` | Chỉ trả preview |
| `GET /post/for-you` | Chỉ trả preview |

---

## 5. Chi tiết implement

### Step 1: Sửa `processPostList()` hỗ trợ privilege map

File: [post.service.ts:1576-1650](src/core/services/post.service.ts#L1576-L1650)

Đổi chữ ký:

```ts
private async processPostList(
  rawPosts: any[],
  currentUserId: string,
  authHeader: string,
  privilegeMap: Map<string, boolean> | boolean = false,
): Promise<PostLikeCommentResponseDto[]>
```

Trong reduce, thay:

```ts
// Cũ
const hasAccess = this.helper.checkPostAccessSync(
  postToReturn, currentUserId, unlockedPostIdSet, isManager,
);

// Mới
const hasCommunityPostPrivilege =
  typeof privilegeMap === 'boolean'
    ? privilegeMap
    : (privilegeMap.get(postToReturn.communityId) ?? false);

const hasAccess = this.helper.checkPostAccessSync(
  postToReturn, currentUserId, unlockedPostIdSet, hasCommunityPostPrivilege,
);
```

Vì `boolean` cũng là giá trị hợp lệ, nên các API cũ truyền `isManager` boolean sẽ không bị ảnh hưởng.

### Step 2: Sửa `getAllPostInCommunity()` build privilege map

File: [post.service.ts:787-813](src/core/services/post.service.ts#L787-L813)

```ts
// Sau khi fetch posts
const uniqueCommunityIds = [...new Set(posts.map((p) => p.communityId))];

const communityPrivilegeMap = new Map<string, boolean>();
await Promise.all(
  uniqueCommunityIds.map(async (cid) => {
    try {
      const perm = await this.helper.fetchMemberPermission(cid, authHeader);
      communityPrivilegeMap.set(cid, this.helper.hasManagerPermission(perm));
    } catch {
      communityPrivilegeMap.set(cid, false);
    }
  }),
);

const processedPosts = await this.processPostList(
  posts, authorId, authHeader, communityPrivilegeMap,
);
```

### Step 3: Sửa `findAppointmentBookingArticle()` cả 2 bug

File repository: [post.repository.adapter.ts:1047-1057](src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L1047-L1057)

Sửa query:

```ts
where: {
  communityId,
  isPublished: false,
  publishedAt: { not: null },
}
```

File controller: thêm `@User('id') userId: string` và `@AuthToken() authorization: string`.

File service: check access theo 5 quyền giống pattern `findOne()`:

```ts
const permissionData = await this.helper.fetchMemberPermission(communityId, authHeader);
const hasCommunityPostPrivilege = this.helper.hasManagerPermission(permissionData);

const unlockedSet = await this.repo.findUnlockedPostIdsByUser(userId, postIds);

// Với mỗi post:
const hasAccess = this.helper.checkPostAccessSync(post, userId, unlockedSet, hasCommunityPostPrivilege);
const secureMedia = this.helper.processSecureMedia(post.media, hasAccess);
return new PostResponseDto({ ...post, media: secureMedia }, hasAccess);
```

### Step 4: Sửa `getPostByHashtag()` thêm authHeader

File controller: thêm `@AuthToken() authorization: string`.

File service: thêm param `authHeader`, fetch permission một lần cho `communityId`, truyền vào `checkPostAccessSync()`.

### Step 5: Sửa `search()` strip premium content

File service: sau khi gọi `searchSmart()`, check `isPremium` + quyền, strip `content`.

Nếu cần chính xác OWNER/POST_CONTENT thì cần privilege map giống step 2.

### Step 6: Cleanup `getAllPostHiddenByCommunityId()`

Sửa `new PostResponseDto(post)` thành `new PostResponseDto(post, true)`.

---

## 6. Thứ tự implement

1. `processPostList()` — hỗ trợ privilege map (nền tảng cho các API khác)
2. `getAllPostInCommunity()` — dùng privilege map
3. `findAppointmentBookingArticle()` — fix query + thêm access check
4. `getPostByHashtag()` — thêm authHeader + permission check
5. `search()` — strip premium content
6. `getAllPostHiddenByCommunityId()` — cleanup explicit hasAccess
