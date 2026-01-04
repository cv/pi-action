# Custom Prompt Template Examples

This document provides examples of how to use the `prompt_template` feature to customize how GitHub issue/PR context is presented to the pi agent.

## Available Template Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{type}}` | Context type | `issue` or `pull_request` |
| `{{type_display}}` | Human-readable type | `Issue` or `Pull Request` |
| `{{number}}` | Issue/PR number | `42` |
| `{{title}}` | Issue/PR title | `Fix login bug` |
| `{{body}}` | Issue/PR description/body | The full description text |
| `{{task}}` | Extracted task (text after trigger phrase) | `please review this code` |
| `{{diff}}` | PR diff (empty string for issues) | The unified diff content |
| `{{trigger_comment}}` | Full trigger comment text | `@pi please review this code` |

## Example Templates

### 1. Basic Custom Template

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Task for {{type_display}} #{{number}}
      
      **Title:** {{title}}
      
      **Description:**
      {{body}}
      
      **Your Task:**
      {{task}}
      
      ## Guidelines
      - Follow our coding standards
      - Write tests for any new code
      - Use conventional commits
```

### 2. Code Review Template (for PRs)

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Code Review Request for PR #{{number}}
      
      ## PR Title
      {{title}}
      
      ## PR Description
      {{body}}
      
      ## Review Task
      {{task}}
      
      ## Diff to Review
      ```diff
      {{diff}}
      ```
      
      ## Review Guidelines
      - Check for security vulnerabilities
      - Verify error handling
      - Ensure adequate test coverage
      - Flag any performance concerns
      - Suggest improvements where appropriate
```

### 3. Minimal Template

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: "{{task}}"
```

### 4. Issue Triage Template

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Issue Triage - {{type_display}} #{{number}}
      
      **Title:** {{title}}
      **Body:** {{body}}
      **Task:** {{task}}
      
      Please help with:
      1. Categorize this issue (bug, feature, enhancement, question)
      2. Assign appropriate labels
      3. Determine priority level
      4. Suggest next steps
```

### 5. Documentation Review Template

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Documentation Review
      
      {{type_display}}: {{title}} (#{{number}})
      
      Content to review:
      {{body}}
      
      Task: {{task}}
      
      Please review for:
      - Clarity and readability
      - Technical accuracy
      - Missing information
      - Formatting and structure
      - Grammar and spelling
```

## Usage Tips

1. **Empty Template**: If `prompt_template` is not provided or is empty, the default template will be used
2. **Variable Substitution**: All `{{variable}}` placeholders are replaced with actual values
3. **Missing Variables**: Unknown placeholders are left as-is (not replaced)
4. **Diff Variable**: `{{diff}}` will be empty for issues, only populated for pull requests
5. **Multiline Support**: Templates can span multiple lines and include markdown formatting

## Testing Your Template

You can test your template by:
1. Creating a draft PR with your template changes
2. Using `@pi test this template` in a comment
3. Checking if the resulting prompt contains the expected content
4. Iterating on the template format as needed