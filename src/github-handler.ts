import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Octokit } from "octokit";
import { clientIdAlreadyApproved, parseRedirectApproval, renderApprovalDialog } from "./workers-oauth-utils";

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AI: any;
}

// Context from the auth flow, encrypted & stored in the auth token
// Provided to the DurableMCP as this.props
export type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
  githubId: string;
};

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

app.options('*', (c) => c.text('', 204));

// Authorization endpoint - show approval dialog or proceed with OAuth
app.get("/authorize", async (c) => {
  try {
    console.log('Authorization request received:', c.req.url);
    
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    console.log('Parsed OAuth request:', { 
      clientId: oauthReqInfo.clientId, 
      scope: oauthReqInfo.scope,
      redirectUri: oauthReqInfo.redirectUri 
    });
    
    const { clientId } = oauthReqInfo;
    if (!clientId) {
      console.error('No clientId in OAuth request');
      return c.text("Invalid request: missing client_id", 400);
    }

    // Check if this client was already approved
    const alreadyApproved = await clientIdAlreadyApproved(
      c.req.raw, 
      oauthReqInfo.clientId, 
      c.env.COOKIE_ENCRYPTION_KEY
    );
    console.log('Client already approved:', alreadyApproved);
    
    if (alreadyApproved) {
      console.log('Client pre-approved, redirecting to GitHub');
      return redirectToGithub(c.req.raw, oauthReqInfo, c.env);
    }

    // Show approval dialog
    const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
    console.log('Client info:', clientInfo);
    
    return renderApprovalDialog(c.req.raw, {
      client: clientInfo,
      server: {
        name: "BestReads MCP Server",
        logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
        description: "The best book recommendations, for you!",
      },
      state: { oauthReqInfo },
    });
    
  } catch (error) {
    console.error('Authorization error:', error);
    return c.text(`Authorization error: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
});

// Handle approval form submission
app.post("/authorize", async (c) => {
  try {
    console.log('Approval form submitted');
    
    const { state, headers } = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY);
    if (!state.oauthReqInfo) {
      console.error('Invalid state in approval form');
      return c.text("Invalid request: missing state", 400);
    }

    console.log('Approval parsed, redirecting to GitHub');
    return redirectToGithub(c.req.raw, state.oauthReqInfo, c.env, headers);
    
  } catch (error) {
    console.error('Approval error:', error);
    return c.text(`Approval error: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
});

// OAuth callback from GitHub
app.get("/callback", async (c) => {
  try {
    console.log('OAuth callback received:', c.req.url);
    
    const stateParam = c.req.query("state");
    const code = c.req.query("code");
    const error = c.req.query("error");
    
    if (error) {
      console.error('OAuth error from GitHub:', error);
      return c.text(`OAuth error: ${error}`, 400);
    }
    
    if (!stateParam) {
      console.error('Missing state parameter in callback');
      return c.text("Missing state parameter", 400);
    }
    
    if (!code) {
      console.error('Missing code parameter in callback');
      return c.text("Missing authorization code", 400);
    }

    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = JSON.parse(atob(stateParam)) as AuthRequest;
    } catch (e) {
      console.error('Error parsing state parameter:', e);
      return c.text("Invalid state parameter", 400);
    }
    
    if (!oauthReqInfo.clientId) {
      console.error('Invalid state: missing clientId');
      return c.text("Invalid state", 400);
    }

    console.log('Exchanging code for access token');

    // Exchange the code for an access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code: code,
        redirect_uri: new URL("/callback", c.req.url).href,
      }),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Failed to fetch access token:', tokenResponse.status, errorText);
      return c.text(`Failed to fetch access token: ${tokenResponse.status}`, 500);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    if (!accessToken) {
      console.error('No access token in response');
      return c.text("Missing access token in response", 400);
    }

    console.log('Access token obtained, fetching user info');

    // Fetch the user info from GitHub
    const octokit = new Octokit({ auth: accessToken });
    const user = await octokit.rest.users.getAuthenticated();
    const { login, name, email, id: githubId } = user.data;
    
    console.log('User authenticated:', { login, name, githubId });

    // Complete the OAuth authorization using the OAuth provider
    const normalizedLogin = login.toLowerCase().trim();
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: normalizedLogin,
      metadata: {
        label: name || login,
      },
      scope: oauthReqInfo.scope || ['read:user', 'user:email'], 
      // This will be available as this.props inside MyMCP
      props: {
        login: normalizedLogin,
        name: name || login,
        email: email || '',
        accessToken,
        githubId: String(githubId),
      } as Props,
    });

    console.log('OAuth flow completed, redirecting to:', redirectTo);
    return Response.redirect(redirectTo);
    
  } catch (error) {
    console.error("Callback error:", error);
    return c.text(`Callback error: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    service: "BestReads GitHub OAuth Handler"
  });
});

// Debug endpoint
app.get("/debug", async (c) => {
  const url = new URL(c.req.url);
  
  return c.json({
    url: c.req.url,
    pathname: url.pathname,
    method: c.req.method,
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    timestamp: new Date().toISOString(),
    env: {
      hasGitHubClientId: !!c.env.GITHUB_CLIENT_ID,
      hasGitHubClientSecret: !!c.env.GITHUB_CLIENT_SECRET,
      hasCookieKey: !!c.env.COOKIE_ENCRYPTION_KEY,
      hasOAuthProvider: !!c.env.OAUTH_PROVIDER,
    },
  });
});

// Token info endpoint for debugging
app.get("/token-info", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.text('Unauthorized', 401);
    }
    
    const token = authHeader.slice(7);
    
    // Validate token with OAuth provider 
    const tokenInfo = await c.env.OAUTH_PROVIDER?.validateAccessToken?.(token);
    if (!tokenInfo) {
      return c.text('Invalid token', 401);
    }
    
    return c.json({
      token: token,
      user: tokenInfo.props,
      instructions: {
        mcp_url: `${new URL(c.req.url).origin}/sse`,
        usage: "Use this token in your MCP client's Authorization header as 'Bearer <token>'"
      }
    });
    
  } catch (error) {
    console.error('Token info error:', error);
    return c.text('Error retrieving token info', 500);
  }
});

// SSE test endpoint for debugging
app.get("/sse-test", (c) => {
  return new Response("data: Hello from SSE test\n\n", {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Last-Event-ID',
    }
  });
});

// Test endpoint to check if MCP endpoints are accessible
app.get("/test-mcp", async (c) => {
  try {
    const mcpResponse = await fetch(new URL("/mcp", c.req.url), {
      headers: {
        'Authorization': c.req.header('Authorization') || '',
      }
    });
    
    return c.json({
      status: "MCP endpoint test",
      mcpStatus: mcpResponse.status,
      mcpHeaders: Object.fromEntries(mcpResponse.headers.entries()),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      status: "MCP endpoint test failed",
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
  }
});

export { app as GitHubHandler };


//Redirect to GitHub OAuth authorization
async function redirectToGithub(
  request: Request, 
  oauthReqInfo: AuthRequest, 
  env: Env,
  headers: Record<string, string> = {}
) {
  const githubAuthUrl = getUpstreamAuthorizeUrl({
    upstream_url: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).href,
    state: btoa(JSON.stringify(oauthReqInfo)),
  });
  
  console.log('Redirecting to GitHub:', githubAuthUrl);
  
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: githubAuthUrl,
    },
  });
}

//Constructs an authorization URL
export function getUpstreamAuthorizeUrl({
  upstream_url,
  client_id,
  scope,
  redirect_uri,
  state,
}: {
  upstream_url: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  state?: string;
}) {
  const upstream = new URL(upstream_url);
  upstream.searchParams.set("client_id", client_id);
  upstream.searchParams.set("redirect_uri", redirect_uri);
  upstream.searchParams.set("scope", scope);
  if (state) upstream.searchParams.set("state", state);
  upstream.searchParams.set("response_type", "code");
  return upstream.href;
}