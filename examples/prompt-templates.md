# Custom Prompt Template Examples

This document provides ready-to-use custom prompt templates for various use cases.

## Available Variables

Use these placeholder variables in your custom templates:

| Variable | Description | Example |
|----------|-------------|----------|
| `{{type}}` | Context type | `issue` or `pull_request` |
| `{{type_display}}` | Human-readable type | `Issue` or `Pull Request` |
| `{{number}}` | Issue/PR number | `42` |
| `{{title}}` | Issue/PR title | `Fix login bug` |
| `{{body}}` | Issue/PR description/body | Full description text |
| `{{task}}` | Extracted task (after trigger phrase) | `please review this code` |
| `{{diff}}` | PR diff (empty for issues) | Unified diff content |
| `{{trigger_comment}}` | Full trigger comment text | `@pi please review this code` |

## Template Examples

### 1. Basic Custom Template

Simple structure modification:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Task for {{type_display}} #{{number}}
      
      **Title:** {{title}}
      **Task:** {{task}}
      
      ## Context
      {{body}}
      
      Please help with this request.
```

### 2. Code Review Template

Focused on pull request reviews:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Code Review for PR #{{number}}: {{title}}
      
      ## Description
      {{body}}
      
      ## Review Request
      {{task}}
      
      ## Changes
      ```diff
      {{diff}}
      ```
      
      ## Review Guidelines
      - Check for security vulnerabilities
      - Verify test coverage
      - Ensure code follows our style guide
      - Flag any performance concerns
      - Suggest improvements where applicable
      
      Please provide a thorough code review.
```

### 3. Minimal Template

Just the essential information:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      **Task:** {{task}}
      
      **Context:** {{title}}
      {{body}}
```

### 4. Issue Triage Template

Specialized for bug reports and feature requests:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # {{type_display}} Triage: {{title}}
      
      ## Issue Details
      {{body}}
      
      ## Triage Request
      {{task}}
      
      ## Triage Guidelines
      - Classify the issue type (bug/feature/enhancement)
      - Assess priority and severity
      - Identify affected components
      - Suggest labels and assignees
      - Provide initial troubleshooting steps if applicable
      
      Please analyze this issue and provide triage recommendations.
```

### 5. Documentation Template

For documentation-focused assistance:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Documentation Task: {{title}}
      
      ## Request
      {{task}}
      
      ## Context
      {{body}}
      
      ## Documentation Standards
      - Use clear, concise language
      - Include practical examples
      - Follow our style guide
      - Ensure accessibility
      - Add cross-references where appropriate
      
      Please help improve our documentation.
```

### 6. Testing Template

Focused on test-related tasks:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Testing Task for {{type_display}} #{{number}}
      
      **Title:** {{title}}
      **Request:** {{task}}
      
      ## Context
      {{body}}
      
      {{#if diff}}
      ## Code Changes
      ```diff
      {{diff}}
      ```
      {{/if}}
      
      ## Testing Requirements
      - Write comprehensive unit tests
      - Include integration tests where needed
      - Ensure edge cases are covered
      - Follow TDD practices
      - Maintain high code coverage
      
      Please help with testing requirements.
```

### 7. Security Review Template

For security-focused reviews:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Security Review: {{title}}
      
      ## Security Assessment Request
      {{task}}
      
      ## Details
      {{body}}
      
      ## Code Changes
      {{diff}}
      
      ## Security Checklist
      - [ ] Input validation and sanitization
      - [ ] Authentication and authorization
      - [ ] Data encryption and secure storage
      - [ ] SQL injection prevention
      - [ ] XSS protection
      - [ ] CSRF protection
      - [ ] Dependency vulnerabilities
      - [ ] Secrets management
      
      Please conduct a thorough security review.
```

## Usage Tips

1. **Test your templates**: Start with simple templates and gradually add complexity
2. **Include context**: Even with custom templates, provide enough context for the AI
3. **Be specific**: Clear instructions lead to better results
4. **Maintain consistency**: Use similar templates across your project for consistency
5. **Version control**: Store your templates in your repository for team sharing

## Conditional Logic

Note that the template system uses simple variable replacement. For more complex conditional logic (like showing diff only for PRs), you might need to:

1. Create separate workflow files for issues vs PRs
2. Use different templates for different event types
3. Handle the logic in your template content

## Troubleshooting

- **Variables not replaced**: Check variable names match exactly (case-sensitive)
- **Empty output**: Ensure template isn't empty or whitespace-only
- **Malformed templates**: Unknown `{{variables}}` are left as-is, not errors
- **Long templates**: No size limits, but consider readability