# Optional Mirai coding provider

Mirai is an OpenAI-compatible API that can be used by a separately managed Codex CLI process for code-generation work. It is not a product runtime dependency and it must never receive marketplace data, user credentials, payment details, or production secrets.

The provider settings shown by Mirai's setup page are:

```toml
model = "gpt-6-astra"
model_provider = "miraiapi"
model_catalog_json = "~/.codex/models.json"

[model_providers.miraiapi]
name = "Mirai API"
base_url = "https://api.miraiapi.com/v1"
wire_api = "responses"
experimental_bearer_token = "<set locally; never commit>"
```

Keep the file containing the bearer token outside this repository and rotate a token after sharing it in a chat or shell history. Verify the returned response metadata and status for each run; a model name supplied by a gateway is a routing claim, not independent proof of upstream weights.

The active Codex desktop task cannot hot-switch its provider while a turn is running. This repository therefore records Mirai as an optional auxiliary provider while the current implementation and acceptance work continue on the configured Codex runtime.

