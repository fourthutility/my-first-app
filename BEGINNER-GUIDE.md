# Claude Code — Beginner's Guide for IB Scout

Welcome! This is a starter playbook for using Claude Code on **this** repo.
It's tailored to what's actually here: a static frontend (`index.html`,
`bd-feed.html`, `scout-report.html`), a Node CLI (`ib-scout/scout.js`),
Supabase Edge Functions (`supabase-functions/`), and SQL migrations.

---

## 1. How to talk to Claude Code

Claude Code works best when you treat it like a smart pair-programmer who
just joined the team. A few habits go a long way:

1. **Be concrete about the goal, not the steps.**
   - Weak: *"refactor index.html"*
   - Strong: *"index.html is 9,000 lines. Split the inline JS for the map
     component into `js/map.js` and load it from the page."*

2. **Point at files and line numbers when you can.** Claude can read them
   instantly, e.g. *"the `callClaude` helper in `ib-scout/scout.js:42`."*

3. **Ask for a plan before a change when the work is non-trivial.**
   *"Before editing, give me a short plan."* You can also press `Shift+Tab`
   to enter **plan mode**, which forces Claude to plan and not edit.

4. **Iterate in small steps.** A 200-line change you can review beats a
   2,000-line change you can't. If a request is big, ask Claude to break
   it into commits.

5. **Verify, don't trust blindly.** After an edit, ask Claude to run the
   tests/linters or open the page in a browser. Read the diff before
   committing.

---

## 2. Slash commands worth learning first

Type `/` to see them all. The high-value ones for this repo:

| Command         | Why you'll use it |
| --------------- | ----------------- |
| `/init`         | Generates a `CLAUDE.md` describing this project. Do this first — it makes every later session smarter. |
| `/review`       | Reviews the diff on your current branch. Run before opening a PR. |
| `/security-review` | Scans pending changes for security issues. Useful since this app handles API keys (Attom, Anthropic, Google, Apollo, HubSpot). |
| `/help`         | Reminder of everything available. |

Also useful:
- **Plan mode** (`Shift+Tab`): plan without editing.
- **`#` memory**: type `# always run \`npm test\` before committing` and
  Claude will remember it across sessions.

---

## 3. Set up the repo for productive sessions

A few quick wins before you ask Claude to build anything new:

### 3a. Create a `CLAUDE.md`
Run `/init`. Then edit it to capture things Claude can't infer, e.g.:
- Which env vars `scout.js` needs (`ATTOM_API_KEY`, `ANTHROPIC_API_KEY`,
  `GOOGLE_PLACES_API_KEY`).
- Where Supabase Edge Functions get deployed and how.
- House style (e.g. *"HTML files are intentionally self-contained, do
  not split them without asking"*).

### 3b. Add a `.env.example`
`scout.js` already references one but it doesn't exist. Ask Claude:
> *"Create `ib-scout/.env.example` listing every env var `scout.js`
> reads, with placeholder values and a one-line comment for each."*

### 3c. Tighten `.gitignore`
Add `.env`, `*.log`, and any local Supabase secrets so you can't leak
keys by accident.

---

## 4. Quality & functionality wins for this app

Pick one of these as your first real task. Each is sized for a single
Claude Code session.

### Quality (refactor / hygiene)
1. **Carve `index.html` into pieces.** It's 9k lines of HTML + CSS + JS
   in one file. Start small: extract the `<style>` block into
   `css/app.css` and link it. Next session: extract one JS feature
   (e.g. the Leaflet map setup) into `js/map.js`.
2. **Add a smoke test for `scout.js`.** A single Node test that mocks
   `fetch` and asserts the pipeline calls the right URLs in the right
   order will catch 80% of future regressions.
3. **Lint + format.** Add Prettier and ESLint configs so every change
   lands in a consistent style. Ask Claude to set them up and run them
   over the repo.
4. **Type-check the Edge Functions.** They're already TypeScript; add a
   `deno check` (or `tsc --noEmit`) script and wire it into a pre-commit
   hook so broken functions can't be deployed.
5. **Centralize the Anthropic call.** `scout.js` and the `ai-brief`
   Edge Function probably both call the API directly. Extract a shared
   helper with retries + timeouts.

### Functionality (user-facing)
1. **Cache Attom lookups.** Each address costs API calls. Add a
   Supabase table that caches by normalized address with a TTL. There's
   already a `apollo-cache-enrich-migration.sql` precedent to follow.
2. **Error states in the UI.** When `scout.js` or an Edge Function
   fails, surface the message in `scout-report.html` instead of a blank
   panel.
3. **Loading + progress UI.** The pipeline has 8 steps — show which one
   is running so users know the page hasn't frozen.
4. **CLI flags for `scout.js`.** Right now it only takes an address.
   Add `--json` (machine output), `--no-llm` (skip Claude calls), and
   `--save <path>` (write the report).
5. **Address validation.** Reject obviously bad input before burning a
   Google Places call.

---

## 5. A good first session — copy/paste prompts

Try these in order. Each one is small, verifiable, and builds a habit.

1. **Map the codebase**
   > *"Read the top-level files and give me a one-paragraph summary of
   > what this project does and how the pieces fit together. Don't
   > change anything."*

2. **Generate `CLAUDE.md`**
   > Run `/init`, then ask:
   > *"Add a 'Running locally' section that explains how to run
   > `ib-scout/scout.js` and which env vars it needs."*

3. **Make `.env.example`**
   > *"Create `ib-scout/.env.example` listing every env var that
   > `scout.js` reads, with a placeholder value and a comment
   > describing each."*

4. **First real refactor**
   > *"Extract the `<style>` block in `index.html` into `css/app.css`
   > and link it from the HTML. Don't change any selectors or
   > behavior. Show me the diff before committing."*

5. **First test**
   > *"Add a Node test for `scout.js` that mocks `fetch` and asserts
   > the order of HTTP calls for one example address. Use the built-in
   > `node:test` runner so we don't need a new dependency."*

---

## 6. Habits that pay off

- **Commit often.** Small commits are easy to revert and easy for
  Claude to summarize.
- **Read every diff before approving.** Especially for SQL migrations
  and Edge Functions — those touch shared state.
- **Keep secrets out of prompts.** Paste the *shape* of an API
  response, not a real one with PII.
- **When stuck, ask Claude to explain, not fix.**
  *"Why is this Edge Function returning 401? Walk me through the
  request, don't change code yet."*

---

## 7. Where to learn more

- `/help` inside Claude Code lists every command.
- Feedback / bugs: <https://github.com/anthropics/claude-code/issues>

Happy building.
