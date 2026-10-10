# Weletic Room: Cloudflare Production Deployment Runbook

## I. Tổng Quan & Trạng Thái Hệ Thống

Toàn bộ mã nguồn monorepo **Weletic Room** đã hoàn tất các vòng kiểm toán bảo mật chuyên sâu (`VICTORY CONFIRMED`), tuân thủ nghiêm ngặt 4 bất biến kiến trúc trong [`.agents/rules/shopify_sync_invariants.md`](./.agents/rules/shopify_sync_invariants.md), và các bản build production của **Next.js Web (`apps/web`)** cùng **Shopify Embedded App (`@weletic/shopify-app`)** đều đạt **Exit Code 0** trên nhánh `main`.

Hệ thống được thiết kế theo kiến trúc **100% Cloudflare Native** vận hành với ngân sách tối ưu:
- **$0/tháng (Free Tier)** hoặc tối đa **$5/tháng (Cloudflare Workers Paid)**
- Không phụ thuộc vào PlanetScale, Upstash, Tinybird, AWS S3 hay Vercel.

---

## II. Danh Mục Tài Nguyên Cloudflare Cần Khởi Tạo

Trước khi triển khai, chuẩn bị tài khoản Cloudflare và tài nguyên theo bảng sau:

| Dịch Vụ | Tên Tài Nguyên (Production) | Mục Đích | Chi Phí Dự Kiến |
| :--- | :--- | :--- | :--- |
| **Cloudflare D1** | `weletic-production` | CSDL lõi SQLite (Users, Workspaces, Programs, Commissions, Loyalty) | $0 (Gói Workers) |
| **Cloudflare R2** | `weletic-media-prod` | Lưu trữ UGC Video Reviews, ảnh sản phẩm Yamax, exports | $0 (10 GB miễn phí, 0đ Egress) |
| **Cloudflare KV** | `weletic-links-kv-prod` | Cache Affiliate shortlinks & Store Domain Resolver | $0 |
| **Cloudflare Queues** | `order-webhook-queue`<br>`order-webhook-dlq` | Tiếp nhận và xử lý bất đồng bộ webhook `orders/paid` & `refunds/create` | $0 (1M tin nhắn/tháng) |
| **Analytics Engine** | `weletic_analytics` | Ghi nhận click/conversion thời gian thực thay thế Tinybird | $0 |
| **Cloudflare for SaaS** | Zone `yamax.co` / Custom Hostnames | Tự động cấp phát SSL cho 100 domain thương hiệu của đối tác | $0 (100 hostnames miễn phí) |

---

## III. Các Bước Triển Khai Chi Tiết (Step-by-Step)

### Bước 1: Khởi Tạo Hạ Tầng Lưu Trữ & Hàng Đợi (Storage & Queues)

Chạy các lệnh `wrangler` sau trên máy quản trị (đã đăng nhập `npx wrangler login`):

```bash
# 1. Khởi tạo Cơ sở dữ liệu Cloudflare D1
npx wrangler d1 create weletic-production

# 2. Khởi tạo R2 Bucket lưu trữ file & video reviews
npx wrangler r2 bucket create weletic-media-prod

# 3. Khởi tạo KV Namespace cho Shortlinks & Store Resolver Cache
npx wrangler kv:namespace create weletic-links-kv-prod

# 4. Khởi tạo Cloudflare Queues và Dead-Letter Queue
npx wrangler queues create order-webhook-dlq
npx wrangler queues create order-webhook-queue --dead-letter-queue order-webhook-dlq
```

---

### Bước 2: Thực Thi D1 Schema Migration & Áp Dụng DDL

Áp dụng bộ DDL migration SQLite đã được tối ưu hóa vào database D1:

```bash
# Áp dụng migration lên database Cloudflare D1 Production
npx wrangler d1 execute weletic-production --file=./apps/web/d1/migrations/0000_init_d1.sql
npx wrangler d1 execute weletic-production --file=./apps/web/d1/migrations/0001_service_auth_nonce.sql

# Xác nhận các bảng chính đã được tạo thành công
npx wrangler d1 execute weletic-production --command="SELECT name FROM sqlite_master WHERE type='table';"
```

---

### Bước 3: Cấu Hình Biến Môi Trường Production (.env)

Thiết lập các biến môi trường cốt lõi cho ứng dụng Next.js và Workers:

```env
# Database & Cloudflare D1 Binding
DATABASE_URL="file:./prisma/dev.db"
CLOUDFLARE_D1_DATABASE_ID="<D1_DATABASE_ID_FROM_STEP_1>"

# Cloudflare R2 Storage (S3-Compatible API)
STORAGE_PROVIDER="s3"
AWS_ACCESS_KEY_ID="<CLOUDFLARE_R2_ACCESS_KEY_ID>"
AWS_SECRET_ACCESS_KEY="<CLOUDFLARE_R2_SECRET_ACCESS_KEY>"
AWS_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
AWS_S3_BUCKET="weletic-media-prod"
NEXT_PUBLIC_CDN_URL="https://media.yamax.co"

# Cloudflare KV & Queues
CLOUDFLARE_LINKS_KV_ID="<KV_NAMESPACE_ID_FROM_STEP_1>"
ORDER_WEBHOOK_QUEUE_NAME="order-webhook-queue"

# Shopify App Integration (Yamax Live Credentials)
SHOPIFY_API_KEY="<SHOPIFY_APP_CLIENT_ID>"
SHOPIFY_API_SECRET="<SHOPIFY_APP_CLIENT_SECRET>"
SHOPIFY_APP_URL="https://app.weletic.com"
SCOPES="read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_discounts,write_discounts"
WELETIC_SERVICE_AUTH_SECRET="<GENERATED_64_CHAR_HEX_SECRET>"
```

---

### Bước 4: Triển Khai Thứ Tự 4 Cloudflare Workers Độc Lập

Triển khai các micro-workers theo đúng thứ tự phụ thuộc kiến trúc:

```bash
# 1. Queue Consumer (Xử lý đơn hàng, hoa hồng, và cộng điểm loyalty)
cd apps/web/workers/queue-consumer
npx wrangler deploy --env production

# 2. Cron Triggers (Đối soát Store Credit & Nhắc hạn điểm loyalty)
cd ../cron-triggers
npx wrangler deploy --env production

# 3. Link Redirector (Affiliate Shortlinks Edge Redirection < 15ms)
cd ../link-redirector
npx wrangler deploy --env production

# 4. Webhook Ingress (Cổng tiếp nhận webhook Shopify tốc độ cao & đẩy Queues)
cd ../webhook-ingress
npx wrangler deploy --env production
```

---

### Bước 5: Triển Khai Shopify Embedded App & Next.js Web

```bash
# 1. Triển khai Embedded Shopify App (Remix + App Bridge v4 + Polaris UI)
pnpm --filter @weletic/shopify-app build
pnpm --filter @weletic/shopify-app deploy

# 2. Triển khai Next.js Web Dashboard & Partner Portal
pnpm --filter web build
# (Deploy output artifacts từ .next lên Cloudflare Pages hoặc Container Runner)
```

---

### Bước 6: Cấu Hình Webhook Subscriptions Trên Shopify Partner Dashboard

Đảm bảo các URL tiếp nhận webhook trên Shopify Partner Dashboard trỏ thẳng vào Cloudflare Ingress Worker:

1. **`orders/paid`**:
   - `https://ingress.weletic.com/webhooks/shopify/orders-paid`
2. **`refunds/create`**:
   - `https://ingress.weletic.com/webhooks/shopify/refunds-create`
3. **`app/uninstalled`**:
   - `https://ingress.weletic.com/webhooks/shopify/app-uninstalled`
4. **`customers/data_request` & `shop/redact`** (Shopify Mandatory GDPR Compliance):
   - `https://ingress.weletic.com/webhooks/shopify/compliance`

---

## IV. Danh Sách Kiểm Tra Hậu Triển Khai (Post-Deployment Verification)

- [ ] **Kiểm tra Latency Edge Redirection**: Gửi HTTP GET đến `https://yamax.co/:test-slug`, xác nhận mã phản hồi `302 Found` trả về trong `< 20ms`.
- [ ] **Kiểm tra Webhook Ingress & Queues**: Kích hoạt sự kiện webhook thử nghiệm qua Shopify CLI (`shopify app webhook trigger --topic orders/paid`), xác nhận Worker phản hồi HTTP `200 OK` trong `< 30ms`.
- [ ] **Kiểm tra Idempotency & Ghi Nhận D1**: Kiểm tra bảng `Commission` và `WeleticLoyaltyEarnGrant` trong D1, xác nhận sự kiện chỉ được ghi nhận một lần duy nhất.
- [ ] **Kiểm tra Tải File R2**: Thử nghiệm upload video review hoặc xuất CSV báo cáo đối tác, đảm bảo URL trả về từ R2 mở trực tiếp và không phát sinh chi phí egress.
- [ ] **Kiểm tra Giám Sát Chi Phí**: Truy cập trang **Billing & Usage** trên Cloudflare Dashboard sau 24h chạy production, xác nhận tổng chi phí nằm hoàn toàn trong hạn mức $0 - $5/tháng.
