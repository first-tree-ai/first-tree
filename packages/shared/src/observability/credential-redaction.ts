const REDACTED = "[REDACTED]";

const SENSITIVE_ASSIGNMENT_KEYS =
  "api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|secret|password|credential|credentials|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token";
const QUOTED_VALUE = `"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'`;
const SENSITIVE_KEY = `["']?(?:${SENSITIVE_ASSIGNMENT_KEYS})["']?`;
const ASSIGNMENT_VALUE = `${QUOTED_VALUE}|[^\\s,'"}&]+`;
const AUTHORIZATION_KEY = `["']?authorization["']?`;
const AUTHORIZATION_SCHEME_VALUE = `[A-Za-z][A-Za-z0-9_-]*\\s+[^\\s'"}]+|[^\\s,'"}]+`;

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHORIZATION_HEADER_RE = new RegExp(`(^|\\r?\\n)(\\s*${AUTHORIZATION_KEY}\\s*:\\s*)([^\\r\\n]*)`, "gi");
const SINGLE_QUOTED_AUTHORIZATION_HEADER_RE = /(')(authorization\s*:\s*)[^'\r\n]*(')/gi;
const DOUBLE_QUOTED_AUTHORIZATION_HEADER_RE = /(")(authorization\s*:\s*)(?:\\.|[^"\\\r\n])*(")/gi;
const AUTHORIZATION_QUOTED_ASSIGNMENT_RE = new RegExp(`(${AUTHORIZATION_KEY}\\s*[:=]\\s*)(${QUOTED_VALUE})`, "gi");
const AUTHORIZATION_SCHEME_ASSIGNMENT_RE = new RegExp(
  `(${AUTHORIZATION_KEY}\\s*=\\s*)(${AUTHORIZATION_SCHEME_VALUE})`,
  "gi",
);
const SENSITIVE_ASSIGNMENT_RE = new RegExp(`(${SENSITIVE_KEY}\\s*[:=]\\s*)(${ASSIGNMENT_VALUE})`, "gi");

/**
 * Redact credential-shaped values inside free-form text.
 *
 * This is intentionally text-oriented rather than URL/log-object oriented:
 * scan-campaign exports can contain copied shell output, headers, config
 * snippets, and logs in one message body. The helper preserves enough shape
 * for analysis while removing live credential values.
 */
export function redactCredentialText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(SINGLE_QUOTED_AUTHORIZATION_HEADER_RE, (_match, open: string, prefix: string, close: string) => {
      return `${open}${prefix}${REDACTED}${close}`;
    })
    .replace(DOUBLE_QUOTED_AUTHORIZATION_HEADER_RE, (_match, open: string, prefix: string, close: string) => {
      return `${open}${prefix}${REDACTED}${close}`;
    })
    .replace(AUTHORIZATION_HEADER_RE, (_match, lineStart: string, prefix: string, assignedValue: string) => {
      return `${lineStart}${prefix}${redactedAssignmentValue(assignedValue)}`;
    })
    .replace(AUTHORIZATION_QUOTED_ASSIGNMENT_RE, (_match, prefix: string, assignedValue: string) => {
      return `${prefix}${redactedAssignmentValue(assignedValue)}`;
    })
    .replace(AUTHORIZATION_SCHEME_ASSIGNMENT_RE, (_match, prefix: string, assignedValue: string) => {
      return `${prefix}${redactedAssignmentValue(assignedValue)}`;
    })
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, prefix: string, assignedValue: string) => {
      return `${prefix}${redactedAssignmentValue(assignedValue)}`;
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|access_token|accessToken|refresh_token|refreshToken|jwt|password|secret|api_key|apiKey|credentials|authorization|code|state)=)[^&#\s]+/g,
      "$1[REDACTED]",
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]");
}

function redactedAssignmentValue(value: string): string {
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value.endsWith(quote)) {
    return `${quote}${REDACTED}${quote}`;
  }
  const trailing = value.at(-1);
  if ((trailing === `"` || trailing === `'`) && !value.slice(0, -1).includes(trailing)) {
    return `${REDACTED}${trailing}`;
  }
  return REDACTED;
}
