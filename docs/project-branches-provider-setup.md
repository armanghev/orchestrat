# Project branches: provider setup for local testing

This is how to register the three provider apps that [project branches](project-branches.md) connects to, and every environment variable the API needs. It's written for **local testing**: a local API and dashboard, a local database, and your own test accounts. Register separate apps for production later.

> The feature is built on `feat/project-branches` and has run only against simulated providers. To test it by hand, follow [the manual test](project-branches-manual-test.md); it uses this guide for app registration.

Safety rules:
- Point the tunnel only at your **local** API (port 8801).
- Use a local database, e.g. `createdb orchestrat_branches`, never the hosted Supabase one.
- Use throwaway test repositories.

---

## 0. Before you start

### 0.1 Local services

| Service | URL |
|---|---|
| API | `http://localhost:8801` (`pnpm dev:api`) |
| Dashboard | `http://localhost:8813` (`pnpm dev:dashboard`) |
| Database | local Postgres, e.g. `postgresql://orchestrat:orchestrat@localhost:5432/orchestrat_branches` |

### 0.2 A stable public HTTPS URL for the API

Providers must reach your API from the internet for webhooks and OAuth callbacks. GitLab.com and Origin only call public HTTPS URLs. The hostname must stay the same across restarts, because it's saved in each app's registration.

Pick one:

- **ngrok with a free static domain.**
  1. Sign up at ngrok.com and claim your free static domain in the dashboard (Domains).
  2. Run `ngrok http --url=<your-name>.ngrok-free.app 8801`.
  
  The free tier shows a one-time "You are about to visit" page in the browser during OAuth redirects. Click **Visit Site**; it doesn't affect webhooks.
- **Cloudflare named tunnel.** This needs a domain on Cloudflare. Run `cloudflared tunnel create orchestrat-dev`, route a hostname such as `orchestrat-dev.<yourdomain>` to `http://localhost:8801`, then `cloudflared tunnel run orchestrat-dev`.

Below, `https://<tunnel>` means that hostname, with no trailing slash.

GitHub documents smee.io for webhook forwarding. It only covers GitHub webhooks, not OAuth callbacks or the other providers, so one real tunnel is simpler.

### 0.3 Core environment variables

Put these in the repository-root `.env`, which the API loads through `apps/api/src/server.ts:10`.

```bash
# existing
ORCHESTRAT_DATABASE_URL=postgresql://orchestrat:orchestrat@localhost:5432/orchestrat_branches
ORCHESTRAT_ALLOWED_ORIGINS=http://localhost:8813

# new for project branches
ORCHESTRAT_PUBLIC_API_URL=https://<tunnel>            # origin only: no path, no trailing slash
ORCHESTRAT_DASHBOARD_URL=http://localhost:8813         # where provider callbacks redirect the browser
ORCHESTRAT_REPOSITORY_SECRET_KEY=<see below>           # base64 of exactly 32 random bytes
ORCHESTRAT_REPOSITORY_SECRET_KEY_ID=local1             # short id stored with each ciphertext
ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS=            # optional "id:base64,id:base64" for rotation
ORCHESTRAT_REPOSITORY_SYNC_ENABLED=true                # in-process webhook worker + reconcile
ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS=60    # 900 in production; 60 makes testing faster
```

Generate the encryption key:

```bash
openssl rand -base64 32
```

Keep the key stable. Changing it without listing the old one in `ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS` makes stored GitLab tokens unreadable, and the connection then asks you to reauthorize.

### 0.4 Full variable reference

| Variable | Required | Format | Used for |
|---|---|---|---|
| `ORCHESTRAT_PUBLIC_API_URL` | when any provider is configured | https origin | callback and webhook URLs the API hands to providers |
| `ORCHESTRAT_DASHBOARD_URL` | when any provider is configured | origin | redirects back to project settings |
| `ORCHESTRAT_REPOSITORY_SECRET_KEY` | when any provider is configured | base64, 32 bytes | AES-256-GCM for stored tokens and signing secrets |
| `ORCHESTRAT_REPOSITORY_SECRET_KEY_ID` | same | `[a-z0-9]{1,16}` | key identifier inside ciphertexts |
| `ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS` | no | `id:base64,…` | decrypting data written with older keys |
| `ORCHESTRAT_REPOSITORY_SYNC_ENABLED` | no (default `true` when a provider is configured) | `true`/`false` | starts the in-process worker |
| `ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS` | no (default 900) | integer ≥ 30 | periodic reconcile |
| `ORCHESTRAT_GITHUB_APP_ID` | GitHub | integer | app JWT `iss` fallback, logging |
| `ORCHESTRAT_GITHUB_APP_CLIENT_ID` | GitHub | `Iv…` | app JWT `iss` (recommended by GitHub), user authorization |
| `ORCHESTRAT_GITHUB_APP_CLIENT_SECRET` | GitHub | string | exchanging the user-authorization code |
| `ORCHESTRAT_GITHUB_APP_SLUG` | GitHub | slug | install link `https://github.com/apps/<slug>/installations/new` |
| `ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64` | GitHub | base64 of the `.pem` | signing app JWTs (RS256) |
| `ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET` | GitHub | string ≥ 32 chars | verifying `X-Hub-Signature-256` |
| `ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID` | GitLab | Application ID | OAuth |
| `ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET` | GitLab | Secret | OAuth token exchange, refresh, revoke |
| `ORCHESTRAT_ORIGIN_APP_ID` | Origin | `app_…` | receipt `aud`, app JWT `iss`, install `client_id` |
| `ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64` | Origin | base64 of the Ed25519 PKCS#8 `.pem` | signing app JWTs (EdDSA) |
| `ORCHESTRAT_ORIGIN_API_BASE` | no | URL | default `https://api.cursor.com/v1/origin`; tests override it |

A provider counts as **configured** only when all of its required variables are set. Otherwise the dashboard shows its Connect button disabled with the reason. The GitLab webhook signing token is generated per connection and stored encrypted in the database, so it isn't an environment variable.

The URLs you'll register, derived from `ORCHESTRAT_PUBLIC_API_URL` and `ORCHESTRAT_DASHBOARD_URL`:

| Purpose | URL |
|---|---|
| GitHub user-authorization callback | `https://<tunnel>/api/v1/repository/callback/github` |
| GitHub Setup URL (dashboard) | `http://localhost:8813/repository/github/setup` |
| GitHub webhook | `https://<tunnel>/api/v1/webhooks/github` |
| GitLab OAuth redirect | `https://<tunnel>/api/v1/repository/callback/gitlab` |
| GitLab webhook | created automatically: `https://<tunnel>/api/v1/webhooks/gitlab/<connection id>` |
| Origin install redirect | `https://<tunnel>/api/v1/repository/callback/origin` |
| Origin webhook | `https://<tunnel>/api/v1/webhooks/origin` |

---

## 1. GitHub App

Docs: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

### 1.1 Create a test repository

1. Create a **private** repository, e.g. `orchestrat-branches-test`, with a README so it has a `main` branch.
2. In **Settings → General → Pull Requests**, check **Automatically delete head branches**. This exercises the case where the head branch is deleted before the merge event arrives.

### 1.2 Register the app

Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (https://github.com/settings/apps/new).

| Field | Value |
|---|---|
| GitHub App name | `Orchestrat Dev <yourname>`: at most 34 characters and globally unique. The URL slug comes from it. |
| Description | `Local testing for Orchestrat project branches` |
| Homepage URL | `https://orchestrat.dev` |
| Callback URL | `https://<tunnel>/api/v1/repository/callback/github` (exactly one; leave wildcard matching off) |
| Expire user authorization tokens | **Checked** (GitHub's recommendation) |
| Request user authorization (OAuth) during installation | **Unchecked**. Orchestrat runs its own authorization with PKCE and state. |
| Enable Device Flow | Unchecked |
| Setup URL | `http://localhost:8813/repository/github/setup`. If GitHub refuses a non-HTTPS URL, expose the dashboard through a second tunnel and use that. |
| Redirect on update | **Checked** |
| Webhook → Active | **Checked** |
| Webhook URL | `https://<tunnel>/api/v1/webhooks/github` |
| Webhook secret | the output of `openssl rand -hex 32`; save it for `ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET` |
| SSL verification | Enabled |

**Permissions → Repository permissions:**

| Permission | Access | Why |
|---|---|---|
| Contents | **Read-only** | `create`, `delete` and `push` events require it. Orchestrat never mints tokens that include it. |
| Metadata | **Read-only** (mandatory) | repository and branch listing, `repository` events |
| Pull requests | **Read-only** | `pull_request` events, listing merged PRs |

Leave every other repository, organization and account permission at **No access**.

**Subscribe to events:** Create, Delete, Push, Pull request, Repository. Installation events arrive without subscribing.

**Where can this GitHub App be installed?** "Only on this account" is fine for testing. Production needs "Any account".

Click **Create GitHub App**.

### 1.3 Collect the credentials

On the app's **General** page:

1. **App ID** → `ORCHESTRAT_GITHUB_APP_ID`.
2. **Client ID** (starts with `Iv`) → `ORCHESTRAT_GITHUB_APP_CLIENT_ID`.
3. **Generate a new client secret** → copy it now → `ORCHESTRAT_GITHUB_APP_CLIENT_SECRET`.
4. **Slug**: the last URL segment of `https://github.com/apps/<slug>` → `ORCHESTRAT_GITHUB_APP_SLUG`.
5. **Private keys → Generate a private key.** A `.pem` downloads. Then:
   ```bash
   base64 -i ~/Downloads/<app>.<date>.private-key.pem | tr -d '\n'
   ```
   → `ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64`. Keep the `.pem` out of the repository, e.g. in `~/.orchestrat-dev/`, and delete the download.

```bash
ORCHESTRAT_GITHUB_APP_ID=123456
ORCHESTRAT_GITHUB_APP_CLIENT_ID=Iv23li...
ORCHESTRAT_GITHUB_APP_CLIENT_SECRET=...
ORCHESTRAT_GITHUB_APP_SLUG=orchestrat-dev-yourname
ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...
ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET=<hex from step 1.2>
```

### 1.4 Install and connect

Don't install from GitHub directly. Start from Orchestrat so the installation gets verified:

1. Open **Project settings → Repository → Connect GitHub**.
2. Authorize the app. The picker lists repositories from your installations; if there are none, it shows **Install the GitHub App**.
3. Choose **Only select repositories** → `orchestrat-branches-test`.
4. GitHub returns to the Setup URL, then you pick the repository.

To confirm webhooks reach you: the app's **Advanced** tab lists recent deliveries and lets you redeliver them for up to 3 days.

### 1.5 Connect to an organization instead

Owners and admins can connect GitHub once for the whole organization (migration `0017`) and then import repositories as projects:

1. Open the organization's **Integrations → Connect GitHub** and authorize the app.
2. Pick an account you've already installed the app on, or **Install on another account**. GitHub's install screen is where you choose **All repositories** or **Only select repositories**; change it later from **Manage on GitHub**.
3. The organization home now lists the repositories that installation reaches, with **Import**. Repositories added to the installation later appear as **New**: GitHub sends `installation_repositories` to the app automatically (no extra event subscription), and the worker re-reads every integration once per `ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS` as a fallback.

No new app permissions are needed: listing uses a metadata-only installation token.

---

## 2. GitLab.com OAuth application

Docs: [GitLab as an OAuth 2.0 provider](https://docs.gitlab.com/integration/oauth_provider/), [OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/).

### 2.1 Create a test group and project

1. Create a group, e.g. `orchestrat-dev-<yourname>`. You're its Owner.
2. Create a project in it, e.g. `orchestrat-branches-test`, initialized with a README.
3. In **Settings → Repository → Branch defaults**, leave the default branch as `main`.
4. Optional: check **Enable "Delete source branch" option by default** on merge requests.

Orchestrat needs **Maintainer or Owner** on the project to create its webhook.

### 2.2 Register the application

Group-owned apps survive changes to one person's account. Go to **Group → Settings → Applications → Add new application**. For a user-owned app instead: **Avatar → Edit profile → Access → Applications**.

| Field | Value |
|---|---|
| Name | `Orchestrat Dev` |
| Redirect URI | `https://<tunnel>/api/v1/repository/callback/gitlab` |
| Confidential | **Checked** (the API keeps the secret server-side) |
| Scopes | **`api`** only. Orchestrat creates and deletes a project webhook, which is a write call. See open question Q7 in the spec for a narrower variant. |

Save. Copy the **Application ID** and **Secret** now; the secret is shown once.

```bash
ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID=<Application ID>
ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET=<Secret>
```

### 2.3 Connect

1. **Project settings → Repository → Connect GitLab.com** → authorize → pick `orchestrat-branches-test`.
2. Orchestrat creates the project webhook. Confirm in GitLab under **Project → Settings → Webhooks**:
   - URL `https://<tunnel>/api/v1/webhooks/gitlab/<id>`;
   - **Push events** and **Merge request events** checked, tag push unchecked;
   - branch filter **All branches**;
   - a **signing token** set ([signing tokens](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens), GA in GitLab 19.1).
3. Use **Recent events** on that webhook to inspect deliveries and **Resend Request** them. GitLab disables a hook temporarily after 4 consecutive failures and permanently after 40; the Orchestrat settings card shows the hook's health.

Don't add a webhook by hand. Orchestrat owns the one it creates and deletes it on disconnect.

---

### 2.4 Connect to an organization instead

**Integrations → Connect GitLab** authorizes as you, then asks for **All projects you maintain** or **Only selected projects**. The organization keeps your tokens (sealed to the integration) and every project imported through it uses them, so:

- Imports need the Maintainer role, as before; the webhook is created per project.
- GitLab has no event for "new project" without group or instance hooks, so new projects appear on the next refresh (the reconcile interval) or **Refresh**.
- Removing the integration is refused while imported projects still use it; disconnect their repositories first.

---

## 3. Cursor Origin app

> Origin is hidden until its API leaves beta. To test it, set `ORCHESTRAT_ORIGIN_ENABLED=true` as well; without it the API loads no Origin adapter and the dashboard offers no Origin button.

Docs: https://cursor.com/docs/api/origin. The API is labelled Early Beta. You need a Cursor plan that includes Origin (Pro or above) in the namespace that owns the app.

### 3.1 Create a native test repository

Create a repository in Origin, e.g. `orchestrat-branches-test`, with an initial commit on `main`.

It must be a **native** Origin repository, not a GitHub mirror. Orchestrat rejects inbound GitHub mirrors, because Origin doesn't send push events for them. Optionally turn on "delete branch on merge".

### 3.2 Generate the app signing key (Ed25519)

Origin accepts only Ed25519 keys ([generate an app signing key](https://cursor.com/docs/api/origin/reference/generate-an-app-signing-key.md)):

```bash
mkdir -p ~/.orchestrat-dev && cd ~/.orchestrat-dev
openssl genpkey -algorithm ED25519 -out origin-app.pem          # private key (PKCS#8) — keep secret
openssl pkey -in origin-app.pem -pubout -out origin-app.pub.pem  # public key to register
base64 -i origin-app.pem | tr -d '\n'                            # → ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64
```

### 3.3 Register the app

Open https://cursor.com/codebase/settings/apps and create an app. The form isn't visible without signing in; these fields come from the [Create App API](https://cursor.com/docs/api/origin/reference/create-app.md), and the UI should offer the same ones.

| Field | Value |
|---|---|
| Display name | `Orchestrat Dev` |
| Description | `Local testing for Orchestrat project branches` |
| Website URL | `https://orchestrat.dev` |
| Public key | the contents of `origin-app.pub.pem` |
| Webhook URL | `https://<tunnel>/api/v1/webhooks/origin` (one per app, HTTPS) |
| Events | `repository.pushed`, `pull_request.merged`, `repository.metadata.updated`, `repository.deleted` (`installation.*` always arrive) |
| Installation redirect URIs | `https://<tunnel>/api/v1/repository/callback/origin` (exact match, HTTPS) |
| Default scopes | `repository:metadata:read repository:contents:read repository:pull_requests:read` |

There is no webhook secret: Origin signs deliveries with its own Ed25519 keys, published at `https://api.cursor.com/v1/origin/keys`.

Copy the **App ID** (`app_…`):

```bash
ORCHESTRAT_ORIGIN_APP_ID=app_...
ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64=<from 3.2>
# ORCHESTRAT_ORIGIN_API_BASE=https://api.cursor.com/v1/origin   (default; leave unset)
```

### 3.4 Connect

1. **Project settings → Repository → Connect Cursor Origin**.
2. On the Cursor install page, as a workspace admin: approve the scopes and choose **selected repositories → `orchestrat-branches-test`**.
3. Cursor redirects back with a signed installation receipt. Orchestrat verifies it (signature, audience, expiry, state, single use) and then confirms the installation through the API.

Unverified points to watch during this test:
- Whether the app's JWT `kid` must be the App ID or the key thumbprint. The docs disagree.
- Whether "private" apps can be installed into a namespace other than their owner's. This matters for production, not for testing in your own namespace.

---

## 4. What to test

The checks for each provider, plus agents and the dashboard without a provider, are in [the manual test](project-branches-manual-test.md). Record results in `docs/acceptance/2026-09-30-project-branches.md`, and leave anything you didn't run marked **NOT RUN**.

---

## 5. Cleanup

- GitHub: uninstall the app (**Settings → Applications → Installed GitHub Apps**), then delete it (**Developer settings → GitHub Apps → Advanced → Delete**).
- GitLab: delete the application and the test group.
- Origin: uninstall the app from the namespace and delete it in codebase settings.
- Delete `~/.orchestrat-dev/*.pem` and remove the variables from `.env`.
- Stop the tunnel.
