# Local Development & Troubleshooting Runbook for Weletic Room

This document captures key operational knowledge, multi-tenant portal architecture, and rapid diagnosis steps for local development in the **Weletic Room** ecosystem.

---

## 1. Local Database & Services Architecture

### Required Docker Containers

When running locally (`apps/web`), Next.js and Prisma depend on two persistent Docker containers:

1. **`web-ps-mysql-1`**: MySQL 8.0 on port `3306`.
2. **`web-planetscale-proxy-1`**: PlanetScale HTTP simulation proxy on port `3900`.
3. **`web-mailhog-1`**: Local SMTP testing UI on port `8025` / `1025`.

### Diagnostic & Fast Recovery:

If Prisma throws `Can't reach database server at localhost:3306`:

```bash
# Check if Docker is running
docker ps -a

# Start containers if stopped
docker start web-ps-mysql-1 web-planetscale-proxy-1 web-mailhog-1
```

---

## 2. Multi-Portal Identity & Dual Roles

The platform cleanly separates the **Merchant Management** domain and the **Creator / Affiliate** domain:

| Domain / Host                                          | App / Role                    | Database Linkage                                                                                              |
| :----------------------------------------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **`app.weletic.com`** (`app.localhost:8888`)           | **Merchant / Brand Console**  | `User` $\rightarrow$ `WorkspaceUser` $\rightarrow$ `Workspace`                                                |
| **`partners.weletic.com`** (`partners.localhost:8888`) | **Creator & Partner Portal**  | `User.defaultPartnerId` $\rightarrow$ `PartnerUser` $\rightarrow$ `Partner` $\rightarrow$ `ProgramEnrollment` |
| **`room.weletic.com`** (`room.localhost:8888`)         | **Public Creator Storefront** | Public catalog resolved via `room.weletic.com/{creatorSlug}`                                                  |

### Important Partner Portal Rule:

When viewing `http://partners.localhost:8888/programs/[programSlug]`, the authenticated user must have:

1. A linked `Partner` record (via `User.defaultPartnerId` & `PartnerUser`).
2. An active `ProgramEnrollment` for that specific program with `status: "approved"`.
3. If an Admin logs into the Partner portal without an enrollment, the system must render a clear fallback / join prompt, never a blank white page (`return null;`).

---

## 3. UI Resilience & Anti-Blank Screen Standard

- **Never return naked `null` during SWR fetch cycles:**
  - When `isLoading` or `!data`, always render standard skeleton loaders (such as `OverviewLoadingSkeleton`).
- **Handle missing/unapproved enrollments gracefully:**
  - Render an informative empty state with actionable buttons (e.g. "Explore Programs" or "Apply to Program").

---

## 4. Isolated Next.js Development Cache

Local development writes Turbopack output to `apps/web/.next-dev`, while production builds continue to use `apps/web/.next`. This prevents a dev server from reusing incompatible production artifacts.

For focused dashboard work without the tunnel, Shopify CLI, or sync poller:

```bash
pnpm --filter web dev:web
```

If a branch switch leaves the dev server in an inconsistent state, stop the server and remove only the isolated cache before restarting:

```bash
test ! -d apps/web/.next-dev || rm -r apps/web/.next-dev
pnpm --filter web dev:web
```
