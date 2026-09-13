import * as client from 'openid-client';
import { config } from '../config/index.js';
import { UnauthorizedError } from '../middlewares/error.js';

/**
 * The three sign-in providers, behind one shared shape so
 * `handlers/auth.handlers.ts` never branches on which provider it is talking
 * to. Google and Microsoft both publish an OpenID Connect discovery
 * document, so `openid-client` (certified, handles discovery + PKCE + state)
 * drives both; GitHub has no discovery document and no ID token, so it is
 * ~40 lines of plain `fetch` against its two fixed endpoints instead.
 */
export interface OAuthProfile {
  readonly provider: string;
  /** The immutable subject the provider issues - accounts are keyed on
   * `(provider, provider_subject)`, never on this profile's `email`, which a
   * user can change at the provider without moving to a new account here. */
  readonly providerSubject: string;
  readonly email: string;
}

/** What `start()` hands back to the caller to keep server-side until the
 * callback arrives - see `handlers/auth.handlers.ts`'s in-memory pending-auth
 * store. Never put in a cookie: `code_verifier` is the PKCE secret and must
 * never reach the browser. */
export interface PendingAuth {
  readonly state: string;
  readonly codeVerifier?: string;
}

export interface OAuthProvider {
  readonly name: string;
  start(redirectUri: string): Promise<{ url: URL; pending: PendingAuth }>;
  complete(callbackUrl: URL, pending: PendingAuth, redirectUri: string): Promise<OAuthProfile>;
}

type FetchLike = typeof fetch;

let fetchOverride: FetchLike | undefined;

/**
 * Test-only seam, the same shape as `middlewares/project-scope.ts`'s
 * `setProjectIdsResolver`: one swappable function, defaulting to the real
 * thing. `tests/auth.test.ts` has no real Google/Microsoft/GitHub client
 * credentials, so it points every outbound call this file and the GitHub
 * provider below make at a mocked responder instead - `openid-client`'s own
 * README documents exactly this hook (`config[client.customFetch] = ...`)
 * as the supported way to mock responses in tests.
 */
export function setOAuthFetch(fetchImpl: FetchLike | undefined): void {
  fetchOverride = fetchImpl;
}

function currentFetch(): FetchLike {
  return fetchOverride ?? fetch;
}

/**
 * Builds a Google- or Microsoft-shaped provider: OIDC discovery, PKCE,
 * `openid email profile` scope, then the userinfo endpoint (not the ID
 * token) for the profile claims. Reading userinfo rather than validating a
 * signed ID token is deliberate, not a shortcut that skips a check: the
 * claims still arrive over the same TLS-authenticated connection as the
 * token exchange, discovery already pinned the issuer, and the access token
 * that unlocks userinfo was itself only just issued to this exact PKCE
 * exchange - there is no ID token signature check whose absence weakens
 * that.
 */
function oidcProvider(
  name: string,
  issuer: URL,
  clientId: string,
  clientSecret: string,
): OAuthProvider {
  // Discovered once, lazily, and cached - same "one instance, built on first
  // use" shape as `lib/db.ts`'s pool. The `customFetch` wrapper below reads
  // `currentFetch()` on every call rather than closing over it at discovery
  // time, so `setOAuthFetch` can still swap the responder in later even
  // though the `Configuration` itself is cached for the process's lifetime.
  let configuration: Promise<client.Configuration> | undefined;

  function getConfiguration(): Promise<client.Configuration> {
    configuration ??= client.discovery(issuer, clientId, clientSecret, undefined, {
      [client.customFetch]: (...args: Parameters<FetchLike>) => currentFetch()(...args),
    });
    return configuration;
  }

  return {
    name,
    async start(redirectUri) {
      const config_ = await getConfiguration();
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const url = client.buildAuthorizationUrl(config_, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });
      return { url, pending: { state, codeVerifier } };
    },
    async complete(callbackUrl, pending) {
      const config_ = await getConfiguration();
      // `authorizationCodeGrant` itself rejects a `state` in the callback
      // that does not match `expectedState` - this is what makes a
      // mismatched-state callback fail for Google and Microsoft.
      const tokens = await client.authorizationCodeGrant(config_, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
      });
      const userinfo = await client.fetchUserInfo(
        config_,
        tokens.access_token,
        client.skipSubjectCheck,
      );
      const email = typeof userinfo.email === 'string' ? userinfo.email : undefined;
      if (!email) {
        throw new UnauthorizedError(`${name} account has no accessible email address.`);
      }
      return { provider: name, providerSubject: userinfo.sub, email };
    },
  };
}

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
}

interface GitHubUser {
  id: number;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * GitHub's OAuth2 App flow: no discovery document, no ID token, just two
 * fixed endpoints. `state` is checked here by hand, against the same
 * server-side `pending` value `handlers/auth.handlers.ts` looked up by state
 * before calling this - GitHub itself echoes `state` back but never
 * validates it for you.
 */
function githubProvider(): OAuthProvider {
  return {
    name: 'github',
    async start(redirectUri) {
      const state = client.randomState();
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set('client_id', config.oauthGithubClientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('state', state);
      return { url, pending: { state } };
    },
    async complete(callbackUrl, pending, redirectUri) {
      const code = callbackUrl.searchParams.get('code');
      const returnedState = callbackUrl.searchParams.get('state');
      if (!code || !returnedState || returnedState !== pending.state) {
        throw new UnauthorizedError('OAuth state mismatch.');
      }

      const tokenResponse = await currentFetch()(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: config.oauthGithubClientId,
          client_secret: config.oauthGithubClientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as GitHubTokenResponse;
      if (!tokenResponse.ok || !tokenBody.access_token) {
        throw new UnauthorizedError('GitHub token exchange failed.');
      }

      const userResponse = await currentFetch()(GITHUB_USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: 'application/vnd.github+json',
          // GitHub's API rejects requests with no User-Agent.
          'user-agent': 'metrion',
        },
      });
      if (!userResponse.ok) {
        throw new UnauthorizedError('GitHub profile lookup failed.');
      }
      const user = (await userResponse.json()) as GitHubUser;

      let email = user.email;
      if (!email) {
        // A user with "Keep my email address private" set has `email: null`
        // on `/user` - the verified primary address is only on `/user/emails`.
        const emailsResponse = await currentFetch()(GITHUB_EMAILS_URL, {
          headers: {
            authorization: `Bearer ${tokenBody.access_token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'metrion',
          },
        });
        if (emailsResponse.ok) {
          const emails = (await emailsResponse.json()) as GitHubEmail[];
          email = emails.find((entry) => entry.primary && entry.verified)?.email ?? null;
        }
      }
      if (!email) {
        throw new UnauthorizedError('GitHub account has no accessible email address.');
      }

      return { provider: 'github', providerSubject: String(user.id), email };
    },
  };
}

const providers = new Map<string, OAuthProvider>();

/** The three provider names this app accepts on `/auth/:provider`. */
export const PROVIDER_NAMES = ['google', 'microsoft', 'github'] as const;

export function getProvider(name: string): OAuthProvider | undefined {
  const cached = providers.get(name);
  if (cached) return cached;

  let provider: OAuthProvider;
  switch (name) {
    case 'google':
      provider = oidcProvider(
        'google',
        new URL('https://accounts.google.com'),
        config.oauthGoogleClientId,
        config.oauthGoogleClientSecret,
      );
      break;
    case 'microsoft':
      provider = oidcProvider(
        'microsoft',
        new URL(`https://login.microsoftonline.com/${config.oauthMicrosoftTenant}/v2.0`),
        config.oauthMicrosoftClientId,
        config.oauthMicrosoftClientSecret,
      );
      break;
    case 'github':
      provider = githubProvider();
      break;
    default:
      return undefined;
  }
  providers.set(name, provider);
  return provider;
}
