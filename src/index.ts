import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { DurableObject } from "cloudflare:workers";

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  USER_BOOK_PREFERENCES: DurableObjectNamespace;
  AI: any;
}

// User authentication context that will be passed to MCP agent
export type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
  githubId: string;
};

// Book preferences state stored per user
interface BookPreferences {
  userName: string;
  favoriteGenres: string[];
  favoriteAuthors: string[];
  booksRead: Array<{
    title: string;
    author: string;
    dateAdded: string;
  }>;
  dislikedBooks: Array<{
    title: string;
    author: string;
    dateAdded: string;
  }>;
  dislikedAuthors: string[];
}

// Durable Object class for storing user book preferences
export class UserBookPreferences extends DurableObject {
  private preferences: BookPreferences | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async getPreferences(): Promise<BookPreferences> {
    if (!this.preferences) {
      this.preferences = await this.ctx.storage.get<BookPreferences>("preferences");
      
      if (!this.preferences) {
        this.preferences = {
          userName: "",
          favoriteGenres: [],
          favoriteAuthors: [],
          booksRead: [],
          dislikedBooks: [],
          dislikedAuthors: [],
        };
        await this.ctx.storage.put("preferences", this.preferences);
      }
    }
    return this.preferences;
  }

  async updatePreferences(newPreferences: BookPreferences): Promise<void> {
    this.preferences = newPreferences;
    await this.ctx.storage.put("preferences", this.preferences);
  }
}

export class MyMCP extends McpAgent<Env, never, Props> {
  private _server: McpServer | undefined;

  set server(server: McpServer) {
    this._server = server;
  }

  get server(): McpServer {
    if (!this._server) {
      throw new Error('Tried to access server before it was initialized');
    }
    return this._server;
  }

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    console.log(`MyMCP initialized:
      - Durable Object ID: ${state.id.toString()}
      - DO ID name: ${state.id.name || 'no name'}`);
  }

  // Get the user's book preferences DO
  get userPreferences(): DurableObjectStub<UserBookPreferences> {
    const userId = this.props?.login || 'anonymous';
    const userPreferencesId = this.env.USER_BOOK_PREFERENCES.idFromName(userId);
    return this.env.USER_BOOK_PREFERENCES.get(userPreferencesId);
  }

  private async getUserPreferences(): Promise<BookPreferences> {
    try {
      return await this.userPreferences.getPreferences();
    } catch (error) {
      console.error("Error getting user preferences:", error);
      return {
        userName: "",
        favoriteGenres: [],
        favoriteAuthors: [],
        booksRead: [],
        dislikedBooks: [],
        dislikedAuthors: [],
      };
    }
  }

  private async updateUserPreferences(preferences: BookPreferences): Promise<void> {
    await this.userPreferences.updatePreferences(preferences);
  }

  async init() {
    console.log(`MyMCP init called - Props available:
      - login: ${this.props?.login}
      - name: ${this.props?.name}
      - githubId: ${this.props?.githubId}`);

    // Initialize MCP server
    this.server = new McpServer({
      name: "BestReads Book Recommendations",
      version: "1.0.0",
    });

    // Initialize username from authentication context
    const userName = this.props?.name || this.props?.login || "Book Lover";
    
    const currentPreferences = await this.getUserPreferences();
    if (currentPreferences.userName !== userName) {
      currentPreferences.userName = userName;
      await this.updateUserPreferences(currentPreferences);
    }

    console.log(`Book Preferences agent initialized for ${userName}`);

    // Register MCP tools
    await this.registerTools();
    
    console.log(`BestReads MCP server ready with all tools initialized`);
  }

  private async registerTools() {
    // ================== MCP TOOLS ==================

    this.server.tool("getProfile", "View your reading history and preferences", {}, async () => {
      const preferences = await this.getUserPreferences();
      
      const favoriteGenres = preferences.favoriteGenres || [];
      const favoriteAuthors = preferences.favoriteAuthors || [];
      const booksRead = preferences.booksRead || [];
      const dislikedBooks = preferences.dislikedBooks || [];
      const dislikedAuthors = preferences.dislikedAuthors || [];
      
      return {
        content: [
          {
            type: "text",
            text: `**${preferences.userName}'s Reading Profile**

**Favorite Genres:** ${favoriteGenres.length > 0 ? favoriteGenres.join(", ") : "None yet"}

**Favorite Authors:** ${favoriteAuthors.length > 0 ? favoriteAuthors.join(", ") : "None yet"}

**Books Read:** ${booksRead.length} books
${booksRead.length > 0 ? booksRead.slice(-3).map(book => 
  `• "${book.title}" by ${book.author}`
).join('\n') : "None yet"}

**Disliked Books:** ${dislikedBooks.length} books
${dislikedBooks.length > 0 ? dislikedBooks.slice(-2).map(book => 
  `• "${book.title}" by ${book.author}`
).join('\n') : "None yet"}

**Disliked Authors:** ${dislikedAuthors.length > 0 ? dislikedAuthors.join(", ") : "None yet"}

**GitHub User:** ${this.props?.login || 'Anonymous'}

Use the available tools to add your preferences for better recommendations.`,
          },
        ],
      };
    });

    this.server.tool(
      "addGenre",
      "Add a book genre you enjoy reading",
      {
        genre: z.string().describe("A book genre you like (e.g., 'science fiction', 'mystery', 'romance')"),
      },
      async ({ genre }) => {
        const preferences = await this.getUserPreferences();
        const normalizedGenre = genre.toLowerCase().trim();
        
        if (preferences.favoriteGenres.includes(normalizedGenre)) {
          return {
            content: [
              {
                type: "text",
                text: `"${genre}" is already in your favorites!

Current genres: ${preferences.favoriteGenres.join(", ")}`,
              },
            ],
          };
        }
        
        preferences.favoriteGenres.push(normalizedGenre);
        await this.updateUserPreferences(preferences);
        
        const encouragement = preferences.favoriteGenres.length === 1 
          ? "Great start! Add more genres to improve recommendations."
          : `Perfect! With ${preferences.favoriteGenres.length} genres, I'm learning your taste.`;
        
        return {
          content: [
            {
              type: "text",
              text: `Added "${genre}" to your favorites!

**Your favorite genres:** ${preferences.favoriteGenres.join(", ")}

${encouragement}`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "addFavoriteAuthor",
      "Add an author you enjoy reading",
      {
        author: z.string().describe("An author you like (e.g., 'J.K. Rowling', 'Stephen King', 'Agatha Christie')"),
      },
      async ({ author }) => {
        const preferences = await this.getUserPreferences();
        const normalizedAuthor = author.trim();
        const favoriteAuthors = preferences.favoriteAuthors || [];
        
        if (favoriteAuthors.includes(normalizedAuthor)) {
          return {
            content: [
              {
                type: "text",
                text: `"${author}" is already in your favorite authors!

Current favorite authors: ${favoriteAuthors.join(", ")}`,
              },
            ],
          };
        }
        
        favoriteAuthors.push(normalizedAuthor);
        preferences.favoriteAuthors = favoriteAuthors;
        await this.updateUserPreferences(preferences);
        
        const encouragement = favoriteAuthors.length === 1 
          ? "Great start! Add more authors to improve recommendations."
          : `Perfect! With ${favoriteAuthors.length} favorite authors, I'm learning your taste.`;
        
        return {
          content: [
            {
              type: "text",
              text: `Added "${author}" to your favorite authors!

**Your favorite authors:** ${favoriteAuthors.join(", ")}

${encouragement}`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "addBookRead",
      "Add a book you have read",
      {
        title: z.string().describe("The book title"),
        author: z.string().describe("The book author"), 
      },
      async ({ title, author }) => {
        const preferences = await this.getUserPreferences();
        
        const booksRead = preferences.booksRead || [];
        
        const bookExists = booksRead.some(
          book => book.title.toLowerCase() === title.toLowerCase() && 
                  book.author.toLowerCase() === author.toLowerCase()
        );
        
        if (bookExists) {
          return {
            content: [
              {
                type: "text",
                text: `"${title}" by ${author} is already in your reading list!`,
              },
            ],
          };
        }
        
        const bookEntry = {
          title,
          author,
          dateAdded: new Date().toISOString(),
        };
        
        booksRead.push(bookEntry);
        preferences.booksRead = booksRead;
        await this.updateUserPreferences(preferences);
        
        return {
          content: [
            {
              type: "text",
              text: `Added "${title}" by ${author} to your reading list!

**Total books read:** ${booksRead.length}
**Recent reads:** 
${booksRead.slice(-3).map(book => 
  `• "${book.title}" by ${book.author}`
).join('\n')}`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "addDislikedBook",
      "Add a book you didn't like",
      {
        title: z.string().describe("The book title"),
        author: z.string().describe("The book author"), 
      },
      async ({ title, author }) => {
        const preferences = await this.getUserPreferences();
        const dislikedBooks = preferences.dislikedBooks || [];
        const bookExists = dislikedBooks.some(
          book => book.title.toLowerCase() === title.toLowerCase() && 
                  book.author.toLowerCase() === author.toLowerCase()
        );
        
        if (bookExists) {
          return {
            content: [
              {
                type: "text",
              text: `"${title}" by ${author} is already in your disliked books list!`,
              },
            ],
          };
        }
        
        const bookEntry = {
          title,
          author,
          dateAdded: new Date().toISOString(),
        };
        
        dislikedBooks.push(bookEntry);
        preferences.dislikedBooks = dislikedBooks;
        await this.updateUserPreferences(preferences);
        
        return {
          content: [
            {
              type: "text",
              text: `Added "${title}" by ${author} to your disliked books list.

This will help me avoid recommending similar books or this author in the future.`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "addDislikedAuthor",
      "Add an author you don't like",
      {
        author: z.string().describe("An author you don't like"),
      },
      async ({ author }) => {
        const preferences = await this.getUserPreferences();
        const normalizedAuthor = author.trim();
        const dislikedAuthors = preferences.dislikedAuthors || [];
        
        if (dislikedAuthors.includes(normalizedAuthor)) {
          return {
            content: [
              {
                type: "text",
                text: `"${author}" is already in your disliked authors list!

Current disliked authors: ${dislikedAuthors.join(", ")}`,
              },
            ],
          };
        }
        
        dislikedAuthors.push(normalizedAuthor);
        preferences.dislikedAuthors = dislikedAuthors;
        await this.updateUserPreferences(preferences);
        
        return {
          content: [
            {
              type: "text",
              text: `Added "${author}" to your disliked authors list.

This will help me avoid recommending books by this author in the future.`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "clearPreferences",
      "Clear all your reading preferences and start fresh",
      {},
      async () => {
        const preferences = await this.getUserPreferences();
        const clearedPreferences: BookPreferences = {
          userName: preferences.userName,
          favoriteGenres: [],
          favoriteAuthors: [],
          booksRead: [],
          dislikedBooks: [],
          dislikedAuthors: [],
        };
        
        await this.updateUserPreferences(clearedPreferences);
        
        return {
          content: [
            {
              type: "text",
              text: `🧹 **All preferences cleared for ${preferences.userName}!**
    
    Your reading profile has been reset:
    • Favorite genres: cleared
    • Favorite authors: cleared  
    • Books read: cleared
    • Disliked books: cleared
    • Disliked authors: cleared
    
    You can start building your preferences again using the available tools.`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "getBookRecommendations", 
      "Get personalized book recommendations based on your preferences",
      {},
      async () => {
        const preferences = await this.getUserPreferences();
        
        // Build contextual prompt for AI recommendations
        let prompt = `Recommend 3 books for ${preferences.userName}. `;
        
        if (preferences.favoriteGenres.length > 0) {
          prompt += `They enjoy these genres: ${preferences.favoriteGenres.join(", ")}. `;
        }
        
        if (preferences.favoriteAuthors.length > 0) {
          prompt += `They like these authors: ${preferences.favoriteAuthors.join(", ")}. `;
        }
        
        if (preferences.booksRead.length > 0) {
          const recentBooks = preferences.booksRead.slice(-5).map(b => 
            `"${b.title}" by ${b.author}`
          );
          prompt += `They have read: ${recentBooks.join(", ")}. `;
        }
        
        if (preferences.dislikedBooks.length > 0) {
          const dislikedBooks = preferences.dislikedBooks.map(b => 
            `"${b.title}" by ${b.author}`
          );
          prompt += `They disliked these books: ${dislikedBooks.join(", ")}. `;
        }
        
        if (preferences.dislikedAuthors.length > 0) {
          prompt += `They don't like these authors: ${preferences.dislikedAuthors.join(", ")}. `;
        }
        
        prompt += `Provide specific book recommendations with title, author, and brief explanation of why they'd enjoy it. Avoid recommending books they've already read or authors they dislike.`;
        
        try {
          // Generate recommendation by using Workers AI
          const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
            prompt,
            max_tokens: 600,
          });
          
          const contextUsed = [];
          if (preferences.favoriteGenres.length > 0) contextUsed.push(`${preferences.favoriteGenres.length} favorite genres`);
          if (preferences.favoriteAuthors.length > 0) contextUsed.push(`${preferences.favoriteAuthors.length} favorite authors`);
          if (preferences.booksRead.length > 0) contextUsed.push(`${preferences.booksRead.length} books read`);
          if (preferences.dislikedBooks.length > 0) contextUsed.push(`${preferences.dislikedBooks.length} disliked books`);
          if (preferences.dislikedAuthors.length > 0) contextUsed.push(`${preferences.dislikedAuthors.length} disliked authors`);
          
          const contextText = contextUsed.length > 0 
            ? `\n\nPersonalized based on: ${contextUsed.join(", ")}.`
            : "\n\nAdd your preferences using the available tools for more personalized recommendations.";
          
          return {
            content: [
              {
                type: "text",
                text: `**Personalized Recommendations for ${preferences.userName}:**

${response.response}${contextText}`,
              },
            ],
          };
        } catch (error) {
          console.error("AI recommendation error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Sorry, I had trouble generating recommendations right now. Please try again in a moment.`,
              },
            ],
          };
        }
      }
    );
  }
}

// Using the correct OAuth Provider pattern based on the actual library API
export default new OAuthProvider({
  // Configure API routes for MCP - these will have OAuth protection
  apiHandlers: {
    '/mcp': MyMCP.serve('/mcp', {
      binding: 'MCP_OBJECT',
      corsOptions: {
        origin: "*",
        methods: "GET, POST, OPTIONS",
        headers: "Content-Type, Authorization",
        maxAge: 86400
      }
    }),
    '/sse': MyMCP.serveSSE('/sse', {
      binding: 'MCP_OBJECT', 
      corsOptions: {
        origin: "*",
        methods: "GET, POST, OPTIONS",
        headers: "Content-Type, Authorization, Cache-Control, Last-Event-ID",
        maxAge: 86400
      }
    }),
  },
  
  // The default handler handles OAuth flow and other non-API requests
  defaultHandler: GitHubHandler,
  
  // OAuth endpoint configuration
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token", 
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read:user", "user:email"],
  // Add access token TTL (optional)
  accessTokenTTL: 3600, // 1 hour
});