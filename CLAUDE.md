# Phoenix Method — Claude Working Rules

## CRITICAL: All Changes Must Go Through a Pull Request

This repo's `main` branch is protected against force-pushes and deletions. Direct pushes to main are technically allowed for admins but should still go through a PR for review/rollback clarity.

### Every time you make changes here, you MUST:

1. **Create a Jira ticket** in project PM (https://phoenixmethod.atlassian.net)
   - Use credentials from `C:\Users\kandy\Work\config\jira-config.json`
   - Describe what is being changed and why

2. **Create a branch** named after the Jira ticket:
   ```bash
   git checkout -b PM-XX-short-description
   ```

3. **Make changes on that branch only**

4. **Push the branch** to GitHub:
   ```bash
   git push origin PM-XX-short-description
   ```

5. **Open a Pull Request** via GitHub API:
   ```python
   import urllib.request, json, ssl, base64

   token = # retrieve via: printf "protocol=https\nhost=github.com\n" | git credential fill
   headers = {'Authorization': 'token ' + token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json'}

   payload = json.dumps({
       'title': 'PM-XX: Short description of change',
       'body': 'Jira ticket: PM-XX\n\nSummary of changes made.',
       'head': 'PM-XX-short-description',
       'base': 'main'
   }).encode()

   req = urllib.request.Request(
       'https://api.github.com/repos/KandyPhoenix/Phoenix-Method/pulls',
       data=payload, headers=headers, method='POST'
   )
   ctx = ssl.create_default_context()
   with urllib.request.urlopen(req, context=ctx) as resp:
       data = json.loads(resp.read())
       print('PR created:', data['html_url'])
   ```

6. **Tell Kandy the PR is ready.** She reviews. Claude may merge the PR **only when Kandy explicitly instructs** (e.g., "merge PR-X", "merge all open PRs", "merge them in order"). **Never auto-merge.** When merging, close the associated Jira ticket and delete the remote feature branch afterward.

---

## Global Nav + Footer — NEVER Duplicate Inline

Nav and footer are **globally managed** via two shared files:

- **`/assets/site-chrome.css`** — all nav and footer styles
- **`/assets/site-chrome.js`** — nav and footer HTML + mobile toggle logic

Every page uses `<div id="pm-nav"></div>` and `<div id="pm-footer"></div>` as placeholders. The JS injects the actual HTML on load.

### Rules:
- **To change nav or footer on any page: edit `site-chrome.js` or `site-chrome.css` only.** The change will apply to all pages automatically.
- **Never hardcode nav or footer HTML directly inside any page file.** It will get out of sync.
- **Nav and footer must always look identical on every page.** There are no page-specific nav/footer variations.
- New pages you create must include these two lines in `<head>`:
  ```html
  <link rel="stylesheet" href="/assets/site-chrome.css">
  ```
  And this before `</body>`:
  ```html
  <script src="/assets/site-chrome.js" defer></script>
  ```
  And placeholders in the body:
  ```html
  <div id="pm-nav"></div>
  ...page content...
  <div id="pm-footer"></div>
  ```

---

## Repo Details
- **Remote:** https://github.com/KandyPhoenix/Phoenix-Method
- **Protected branch:** main (force-push + deletion blocked; no review requirement)
- **Jira project:** PM
- **Owner/reviewer:** Kandy (KandyPhoenix)
- **Merge authority:** Kandy only, or Claude when explicitly instructed
