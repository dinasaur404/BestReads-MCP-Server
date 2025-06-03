# BestReads MCP Server

This is a remote MCP server, built on [Cloudflare Workers](https://workers.cloudflare.com/), that provides personalized book recommendation. 

This was built using Cloudflare's [guide](https://developers.cloudflare.com/agents/guides/remote-mcp-server/) on deploying remote MCP servers. It uses the [Agents SDK](https://developers.cloudflare.com/agents/) to build the MCP server, [Durable Objects](https://developers.cloudflare.com/durable-objects/) to persist the user's book preferences, [Workers AI](https://developers.cloudflare.com/workers-ai/) to generate book recommendations, and Cloudflare's [OAuth Provider library](https://github.com/cloudflare/workers-oauth-provider) to add GitHub as an authentication provider. The MCP server supports Server-Sent Events (/sse) and Streamable HTTP (/mcp) [transport methods](https://developers.cloudflare.com/agents/model-context-protocol/transport/). 

### Get Started
To try it out, connect to `https://bestreads.dinas.workers.dev/sse` or `https://bestreads.dinas.workers.dev/mcp`, if your MCP client supports Streamable HTTP. Or, deploy it yourself using the Deploy to Cloudflare button + instructions below. 

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dinasaur404/BestReads-MCP-Server)

## Available Tools

- getProfile - View your reading history and preferences
- addGenre - Add favorite book genres
- addFavoriteAuthor - Add authors you enjoy
- addBookRead - Track books you've read
- addDislikedBook - Mark books you didn't enjoy
- addDislikedAuthor - Authors to avoid in recommendations
- clearPreferences - Reset all preferences
- getBookRecommendations - Get AI-powered personalized book suggestions

## Deploy the MCP server

### Setup

1. Clone the repository
 ```bash
   git clone <your-repo-url>
   cd bestreads-mcp-server
   npm install
   ```

2. Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

- Once you create teh OAuth App, set the Authorization callback URL to https://your-worker-domain.workers.dev/callback
- Note the ClientID and Client Secret. You will add those to your Wrangler file. 
- (Optional) Generate Cookie Encryption Key

3. Upgrade your `wrangler.toml` file
```
[vars]
GITHUB_CLIENT_ID = "your_github_client_id"
GITHUB_CLIENT_SECRET = "your_github_client_secret"
COOKIE_ENCRYPTION_KEY = "your_32_byte_hex_key"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "your_kv_namespace_id"

[[durable_objects.bindings]]
name = "MCP_OBJECT"
class_name = "MyMCP"

[[durable_objects.bindings]]
name = "USER_BOOK_PREFERENCES"
class_name = "UserBookPreferences"
```

4. Deploy to Cloudflare Workers
`wrangler deploy`
