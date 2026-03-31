# Phoenix Method — Claude Working Rules

## CRITICAL: All Changes Must Go Through a Pull Request

This repo's `main` branch is protected. **Direct pushes to main will be rejected.**

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
       'https://api.github.com/repos/KandyAngel27/Phoenix-Method/pulls',
       data=payload, headers=headers, method='POST'
   )
   ctx = ssl.create_default_context()
   with urllib.request.urlopen(req, context=ctx) as resp:
       data = json.loads(resp.read())
       print('PR created:', data['html_url'])
   ```

6. **Tell Kandy the PR is ready** — she reviews and merges. Nothing goes live until she approves.

---

## Repo Details
- **Remote:** https://github.com/KandyAngel27/Phoenix-Method
- **Protected branch:** main (requires 1 approval to merge)
- **Jira project:** PM
- **Owner/reviewer:** Kandy (KandyAngel27)
