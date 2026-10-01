/**
 * The protected path classes of a workspace-relative path (owner decision 2026-09-27, DOMAINS
 * 7922ee3): auth, secrets, CI, deploy, migrations, lockfiles and git internals. One locked list
 * for the owned-worker risk class (`taskRisk`, packages/orchestrator) and the slice classifier's
 * rules fallback, so the two cannot drift. Changing it is a policy change in a reviewed commit,
 * never tuned by what is learned. Classes only, never a path or its content.
 */

export type ProtectedClass = 'PROTECTED_GIT' | 'PROTECTED_CI' | 'PROTECTED_DEPLOY' | 'PROTECTED_MIGRATIONS' | 'PROTECTED_LOCKFILE' | 'PROTECTED_SECRETS' | 'PROTECTED_AUTH';

/** Locked: protected path classes, matched case-insensitively on each path segment. */
const SEGMENT_RULES: readonly (readonly [ProtectedClass, RegExp])[] = [
  ['PROTECTED_GIT', /^\.git$/],
  ['PROTECTED_CI', /^(\.github|\.circleci|\.buildkite|\.gitlab|\.woodpecker|\.drone)$|^(\.gitlab-ci|\.travis|azure-pipelines|bitbucket-pipelines|\.drone|appveyor|cloudbuild|buildspec)\.ya?ml$|^jenkinsfile$/],
  ['PROTECTED_DEPLOY', /^(deploy|deploys|deployment|deployments|infra|infrastructure|terraform|k8s|kubernetes|helm|charts|ansible|pulumi|\.aws)$|^dockerfile(\..*)?$|\.dockerfile$|^(docker-)?compose(\.[a-z0-9-]+)?\.ya?ml$|^procfile$|^(fly|netlify|wrangler)\.toml$|^(vercel|app)\.json$|^(serverless|app|skaffold)\.ya?ml$|\.(tf|tfvars|hcl)$/],
  ['PROTECTED_MIGRATIONS', /^(migrations?|migrate|alembic|flyway|liquibase)$|migration/],
  ['PROTECTED_LOCKFILE', /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock|gemfile\.lock|composer\.lock|go\.sum|uv\.lock|flake\.lock|packages\.lock\.json|mix\.lock|pubspec\.lock|podfile\.lock|gradle\.lockfile)$|\.lock$/],
  ['PROTECTED_SECRETS', /^\.env(\..*)?$|^\.(npmrc|netrc|pypirc|pgpass|htpasswd)$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|gpg|asc)$|^id_(rsa|dsa|ecdsa|ed25519)|(^|[._-])(secrets?|credentials?|creds|keychain|vault|private[._-]?keys?)([._-]|$)/],
  ['PROTECTED_AUTH', /(^|[._-])(auth|authn|authz|oauth2?|oidc|saml|sso|login|logins|passwords?|passwd|permissions?|rbac|acl|iam|sessions?)([._-]|$)/],
];

/** The protected classes a workspace-relative path touches (ids only). */
export function protectedClasses(path: string): readonly ProtectedClass[] {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .map((s) => s.toLowerCase());
  const out: ProtectedClass[] = [];
  for (const [reason, rule] of SEGMENT_RULES) if (segments.some((s) => rule.test(s)) && !out.includes(reason)) out.push(reason);
  return out;
}

