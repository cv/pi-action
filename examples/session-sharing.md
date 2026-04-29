# Session Sharing

pi-action automatically uploads the complete agent session as a GitHub Actions artifact after each run. This provides transparency and debugging data without requiring a gist PAT.

## What's Included in Sessions

The session artifact contains:

- `session.html` - Human-readable session export
- `session.jsonl` - Native pi session data for tooling/auditing

The exported session includes:

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
📎 [Download session artifact](https://github.com/owner/repo/actions/runs/123456789/artifacts/987654321)
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

- Session artifacts inherit the repository/workflow run visibility
- No extra PAT or `gist` scope is required
- Artifact retention follows your repository's GitHub Actions artifact settings
- Sessions include the same information that would be visible in the workflow logs and repository checkout

## Use Cases

### Debugging Agent Issues
When the agent makes unexpected changes or fails:
```
@pi fix the test failures

# Agent makes some changes but tests still fail
# Session artifact shows exactly what the agent tried to do
# and why it didn't work
```

### Code Review and Auditing
For security-sensitive repositories:
```
@pi review this pull request for security issues

# Session artifact shows:
# - What files the agent examined
# - What security checks it performed
# - Its reasoning for each finding
```

### Team Collaboration
Sharing agent interactions with team members:
```
@pi implement the user authentication feature

# Share the artifact link with team members to show:
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
