# Session Sharing

pi-action automatically shares the complete agent session as a viewable HTML link after each run. This provides full transparency and debugging capabilities.

## What's Included in Sessions

- **Full conversation history** - Every message between user and agent
- **Tool executions** - All file reads, writes, bash commands, and their outputs
- **Agent reasoning** - Step-by-step decision making process
- **Error details** - When things go wrong, see exactly what happened
- **Context and prompts** - The full context provided to the agent

## Default Behavior

By default, session sharing is **enabled**:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    # share_session defaults to true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

When a session is shared, the comment will include a link like this:

```markdown
### 🤖 pi Response

I've analyzed the code and made the following changes:

1. Fixed the null reference issue in `src/utils.ts`
2. Added proper error handling in the API client

All tests are passing now.

---
📎 [View full session](https://shittycodingagent.ai/session?abc123def456)
```

## Disabling Session Sharing

To disable session sharing:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    share_session: false
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Privacy and Security

- Sessions are uploaded as **secret** (non-public) GitHub gists
- Only people with the direct link can access the session
- Sessions include the same information that would be in your repository anyway

## Token Requirements

**Important:** The default `GITHUB_TOKEN` does not have permission to create gists. To enable session sharing, provide a separate Personal Access Token (PAT) with the `gist` scope via the `gist_token` input:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}  # For issues, PRs, reactions
    gist_token: ${{ secrets.PAT_WITH_GIST_SCOPE }}  # PAT with gist scope only
    share_session: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

This separation follows the principle of least privilege - the PAT only needs `gist` scope, not full repo access.

If gist creation fails (e.g., due to missing permissions), the action will gracefully continue and post the response without a session link. This ensures the action never fails due to session sharing issues.

## Use Cases

### Debugging Agent Issues
When the agent makes unexpected changes or fails:
```
@pi fix the test failures

# Agent makes some changes but tests still fail
# Session link shows exactly what the agent tried to do
# and why it didn't work
```

### Code Review and Auditing
For security-sensitive repositories:
```
@pi review this pull request for security issues

# Session link shows:
# - What files the agent examined
# - What security checks it performed  
# - Its reasoning for each finding
```

### Team Collaboration
Sharing agent interactions with team members:
```
@pi implement the user authentication feature

# Share the session link with team members to show:
# - How the feature was implemented
# - What design decisions the agent made
# - Full audit trail of all changes
```

### Error Analysis
When something goes wrong:
```
@pi deploy to staging

# If deployment fails, session shows:
# - What deployment steps were attempted
# - Error messages and outputs
# - Agent's troubleshooting attempts
```

## Session Viewer Features

The session viewer at `https://shittycodingagent.ai/session` provides:

- **Syntax highlighting** for code and diffs
- **Collapsible sections** for tool outputs
- **Timeline view** of the conversation
- **Search functionality** to find specific content
- **Mobile-friendly** responsive design

## Example Session Structure

A typical session includes:

```
🔄 Turn started
├── 📖 read src/utils.ts
├── 🔧 bash: npm test
├── 📝 edit src/utils.ts (applied changes)
├── 🔧 bash: npm test (tests now pass)
└── ✅ Turn completed

Agent Response: "Fixed the null reference issue..."
```

Each step shows:
- Input parameters
- Full output/results  
- Execution time
- Success/error status