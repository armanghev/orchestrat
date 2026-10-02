# Project branches: testing by hand

This is the hands-on test of [project branches](project-branches.md) before
release. It covers the local stack, agents, the dashboard and the three real
providers. App registration is in the
[provider setup guide](project-branches-provider-setup.md). Record results in
the [acceptance record](acceptance/2026-09-30-project-branches.md); anything you
skip stays **NOT RUN**.

Time: about 45 minutes for parts 1–3, then about 30 minutes per provider.

Everything runs against a **local** API and a **separate local database**.
Nothing here touches the hosted database, which isn't migrated to `0016` yet.
The macOS desktop app isn't covered: it needs a cargo build and more free disk.
Test the web dashboard instead.

## 1. Bring up the local stack

Run these from the `feat/project-branches` checkout unless noted.

1. Start Postgres. The local `.env` uses Homebrew `postgresql@17` on port 5433:

   ```bash
   brew services start postgresql@17
   ```

2. Create a separate database, so migration `0016` stays out of your everyday
   one:

   ```bash
   createdb -p 5433 orchestrat_branches
   ```

3. Copy `.env`, `apps/dashboard/.env` and `apps/dashboard/.env.local` from
   your main checkout into this one. They're gitignored, so the worktree has
   none. In the root `.env`:
   - change the database name in `ORCHESTRAT_DATABASE_URL` to
     `orchestrat_branches`;
   - add the variables from setup guide §0.3. The provider variables can wait
     until part 4.
4. Build once, migrate, then start the API and the dashboard in two terminals:

   ```bash
   pnpm install && pnpm build
   pnpm db:migrate
   pnpm dev:api        # http://localhost:8801
   pnpm dev:dashboard  # http://localhost:8813
   ```

5. Open http://localhost:8813 and sign in with your usual account. Sign-in
   still goes through hosted Supabase Auth; the local database creates your
   user on first sign-in. Create an organization and a project, for example
   **Branches test**.

- [ ] The breadcrumb shows `… › Branches test › main`.

## 2. Agents on branches (no provider yet)

The branch-following CLI isn't published, so install it from this checkout.
It replaces the `orchestrat` command that every agent on this Mac uses. Against
the hosted API it falls back to today's behavior, but put the old one back when
you're done (part 6).

```bash
mkdir -p ~/.orchestrat-dev
cp ~/.local/bin/orchestrat ~/.orchestrat-dev/orchestrat.backup
pnpm cli:install
```

Make a scratch repository and connect it to the **local** API. The CLI
remembers the API per folder, so your other folders keep using the hosted one.

```bash
mkdir -p ~/dev/branches-test && cd ~/dev/branches-test
git init -b main && git commit --allow-empty -m init
ORCHESTRAT_API_URL=http://localhost:8801 ORCHESTRAT_WEB_URL=http://localhost:8813 orchestrat setup
```

Approve in the local dashboard and pick **Branches test**. For part 4, clone
each provider's test repository and run the same `setup` in the clone.

- [ ] Start Claude Code or Codex in the scratch repository and ask it to call
      `get_project`. It reports `branch: main`, and the dashboard's Agents page
      shows it online on `main`.
- [ ] Quit, run `git checkout -b feat/local` (don't push) and start a new
      session. `feat/local` appears in the branch menu. Ask the agent to create
      a task: it shows on `feat/local`, not on `main`.
- [ ] Open `feat/local` in the dashboard. The setup panel offers to import and
      says the agent's task will be kept. **Start blank** keeps it.
- [ ] Mid-session, with no claimed task, run `git checkout main`. The next tool
      result carries `branch_switched`, and new work lands on `main`.
- [ ] Have the agent claim a task, then switch the checkout. The result
      carries `branch_mismatch`, and the session stays where it was.
- [ ] Ask the agent for `list_branches`, then `select_branch` to another
      branch, then `select_branch` with `follow_checkout: true`.
- [ ] `orchestrat branch current --integration claude-code` (or `codex`) shows
      the checkout, any pin and the default branch.
      `orchestrat branch select main --integration …` pins the checkout;
      `orchestrat branch select --follow --integration …` removes the pin.
- [ ] With the checkout and the agent on `feat/local`, archive `feat/local` in
      the dashboard. The agent's session closes and its claims are released.
      Its next tool result carries `branch_archived`, and it works on `main`.

## 3. The dashboard (no provider yet)

- [ ] Branch menu: switching adds `?branch=` to the URL. Overview, Tasks,
      Documents, Messages, Activity and Agents follow, and so does sidebar
      navigation. ⌘K → **Switch to branch …** works, also in a phone-width
      window.
- [ ] **New branch** → the setup panel → **Pick items…**:
  - choosing a task brings the tasks it depends on, locked with
    "Required by …";
  - each conflict needs **Use source** or **Use target** before Import is
    enabled;
  - after Import, the target has what the summary said.
- [ ] Open the import dialog on a conflict, then edit that item on the target
      in a second tab. The dialog clears your choice for it and highlights it.
- [ ] Settings → Branches:
  - **Set as default**: the confirm mentions older clients;
  - **Merge into…**: preview, then **Merge**;
  - **Archive**: the confirm says nothing is deleted.
- [ ] After a merge with a conflict, Overview shows **Needs your decision** and
      the sidebar shows the count. On Decisions, open it and choose; the item
      updates on the target and the count drops.
- [ ] An archived branch shows a banner. Everything is readable, there's no New
      task, New document or message composer, and **Import into another
      branch** works.
- [ ] Type in a document without saving, then switch branch: you're asked
      first.
- [ ] With a document open in one tab, make another branch the default in a
      second tab. The first tab stays on its branch and keeps the draft.
- [ ] Optional, needs a second account: invite it to the project as a member.
      It can't merge, archive, set the default or import into the default
      branch, and it sees Decisions without the choice buttons.

## 4. Real providers

1. Start a tunnel to the API (setup guide §0.2), for example
   `ngrok http --url=<your-static-domain> 8801`.
2. Put its URL in `ORCHESTRAT_PUBLIC_API_URL`.
3. Register the apps: §1 GitHub, §2 GitLab.com, §3 Cursor Origin.
4. Add their variables to `.env` and restart `pnpm dev:api`.

Settings → Repository then shows **Connect** enabled for each configured
provider. Do the common checks below for each provider, with a clone of its
test repository connected to the local API as in part 2.

Common checks:

- [ ] **Connect.** The default-branch step says **Link** when the repository's
      default is already `main`. To see the rename case, connect a repository
      whose default is `trunk`.
- [ ] **New branch.** Run
      `git checkout -b feat/one && git commit --allow-empty -m one && git push -u origin feat/one`.
      `feat/one` appears within seconds. The provider shows the delivery as
      successful (GitHub: the app's **Advanced** tab; GitLab: the webhook's
      **Recent events**).
- [ ] **Merge.**
  - On `feat/one`, add a task and edit a document in Orchestrat. Edit the
    same document on `main`.
  - Open a PR/MR from `feat/one` into `main` and merge it, deleting the head
    branch.
  - Settings → Branches → **Merge history** shows the run with a link to the
    PR/MR.
  - The task is now on `main`, the document waits on Decisions, and `feat/one`
    is archived.
- [ ] **Delete.** Delete a pushed branch on the provider
      (`git push origin --delete feat/two`): it's archived. Push `feat/two`
      again: a new, empty `feat/two` appears and the archived one is
      untouched.
- [ ] **Missed events.** Stop `pnpm dev:api`, push `feat/three`, then start it
      again. `feat/three` appears within about a minute, through reconcile.
- [ ] **Default change.** Change the repository's default branch on the
      provider. The Orchestrat default follows.
- [ ] **Unpushed branch.** In the clone, run `git checkout -b feat/local2` and
      start an agent. The branch exists in Orchestrat before any push. Pushing
      it later links it instead of creating a second one.
- [ ] **Disconnect.** Branches and their work remain. For GitLab, the webhook
      is gone.

GitHub:

- [ ] Click **Connect GitHub** before installing the app. The picker offers
      **Install the GitHub App**. After you install it, GitHub returns to the
      Setup URL and the picker lists the repository.
- [ ] Suspend the installation (GitHub → Settings → Applications → Configure
      → Suspend). Settings shows **Suspended**. Unsuspend it: **Active**.
- [ ] Optional: merge a PR from a fork. Merge history shows the run as skipped
      because it came from a fork.

GitLab.com:

- [ ] The webhook has a signing token and only Push and Merge request events.
- [ ] Stop `pnpm dev:api` but leave the tunnel running, and push four times;
      GitLab pauses the hook. Start the API and press **Sync now**. Settings
      shows the paused hook, and **Re-enable** wakes it.
- [ ] Revoke the app (GitLab → Preferences → Applications → Authorized
      applications). After **Sync now**, the status is **Needs
      reauthorization**, and **Reconnect** restores it.

Cursor Origin:

- [ ] **Connect** succeeds. If it fails, copy the API's log line. Two things
      are unverified against the live API: the app JWT `kid`, and the endpoint
      that reads one branch.
- [ ] If you have a GitHub-mirror repository, the picker lists it but explains
      why it can't be chosen.

## 5. Record results

Add a **Live providers (ORC-44)** section to the acceptance record, with
PASS or FAIL and what you saw for each check. Or paste your notes to Claude and
ask it to write the section. Leave what you didn't run as **NOT RUN**.

## 6. Clean up

- Put the old CLI back:
  `cp ~/.orchestrat-dev/orchestrat.backup ~/.local/bin/orchestrat`.
- Stop the API, the dashboard and the tunnel. Run
  `brew services stop postgresql@17` if you don't need Postgres.
- Delete the provider apps and the test repositories (setup guide §5).
