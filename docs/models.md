# Models and authentication

pi-action uses `provider` and `model` to select the model. The default is `claude-sonnet-5-5` from `anthropic`. pi-action can use three types of providers:

1. **Built-in pi providers**, such as `anthropic`, `openai`, and `google`. Give the key in an environment variable.
2. **One custom provider and model**, set with the `provider_*` and `model_*` inputs. Use it for a gateway, an internal endpoint, or a local model server.
3. **Providers from pi extensions**, loaded with `extensions`.

pi-action does not read or write `~/.pi`. All configuration comes from the inputs and the environment of the step.

## Authentication

Give the key to the provider in its usual environment variable. This is the preferred method, because pi finds the key the same way as on your computer:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Common variables are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, and `OPENROUTER_API_KEY`. For the full list, see the provider documentation of pi.

As an alternative, use the `api_key` input. pi-action gives the key to the selected `provider` for this run only. It keeps the key in memory and does not write it to a file:

```yaml
with:
  provider: anthropic
  api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

pi-action cannot do OAuth logins on a runner. Use an API key.

## Use a different built-in model

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: 'openai'
    model: 'gpt-4o'
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

When pi does not know the model, the run fails and pi-action reports the error on the issue.

## A custom provider and model

Use the `provider_*` and `model_*` inputs for one model that pi does not know. You do not need a `models.json` file of pi. Set `provider_base_url` to enable these inputs. For each input, see [Inputs](../README.md#inputs).

This example uses `openai/openai/gpt-5.5` from NVIDIA with the OpenAI Responses API:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: nvidia
    model: openai/openai/gpt-5.5
    api_key: ${{ secrets.NVIDIA_API_KEY }}
    provider_base_url: https://inference-api.nvidia.com
    provider_api: openai-responses
    model_name: GPT-5.5 (OpenAI)
    model_reasoning: true
    model_input: text,image
    model_context_window: 1050000
    model_max_tokens: 16384
```

This example uses a local server (Ollama, LM Studio, vLLM, or similar) on a self-hosted runner:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: spark
    model: huggingface.co/unsloth/gemma-4-26b-a4b-it-gguf:Q8_0
    provider_base_url: http://192.168.1.16:12434/v1
    provider_api: openai-completions
    provider_api_key: spark
    model_name: Gemma 4 26B-A4B IT Q8 (Spark)
    model_context_window: 128000
    model_max_tokens: 16384
```

Rules for the key of a custom provider:

- You must set `api_key` or `provider_api_key`. If you set neither, the run fails.
- `api_key` has priority over `provider_api_key`.
- `provider_api_key` is the name of an environment variable when it has only capital letters, digits, and underscores, and starts with a letter (for example `SPARK_KEY`). Any other value is the key itself.
- For a local server that does not check keys, set `provider_api_key` to any value.

The runner sends the requests. A `localhost` or LAN address must be reachable from the runner. Use a self-hosted runner or an internal endpoint that the runner can reach.

For Anthropic-compatible endpoints (`provider_api: anthropic-messages`) with Claude Opus 4.6+ or Sonnet 4.6+, set `compat_force_adaptive_thinking: true`.

## Providers from pi extensions

A [pi extension](https://github.com/earendil-works/pi) can register a provider with `pi.registerProvider()`. Load the extension with `extensions`, then select its provider with `provider` and `model`:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extensions: |
      @acme/pi-provider@1.4.2
      ./.pi/extensions/gateway.ts
    provider: acme
    model: acme-large
  env:
    ACME_API_KEY: ${{ secrets.ACME_API_KEY }}
```

For how pi-action installs and loads extensions, and what it uses from them, see [Extensions](extensions.md#providers).
