import { PrivacyConfig } from "../config";

interface RedactionRule {
  regex: RegExp;
  replacement: string;
}

const BUILTIN_SECRET_RULES: RedactionRule[] = [
  {
    // OpenAI API key
    regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    // Anthropic API key
    regex: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  {
    // GitHub classic/token patterns
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    // AWS access key ID
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    // Generic bearer token
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    // JWT token
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
];

const EMAIL_RULE: RedactionRule = {
  regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  replacement: "[REDACTED_EMAIL]",
};

function compileCustomRules(config: PrivacyConfig): RedactionRule[] {
  const out: RedactionRule[] = [];
  for (const pattern of config.additionalRedactionPatterns) {
    try {
      const regex = new RegExp(pattern, "gi");
      out.push({
        regex,
        replacement: "[REDACTED_CUSTOM]",
      });
    } catch {
      // Invalid custom patterns are ignored to avoid blocking ingestion.
    }
  }
  return out;
}

function applyRules(input: string, rules: RedactionRule[]): string {
  let output = input;
  for (const rule of rules) {
    output = output.replace(rule.regex, rule.replacement);
  }
  return output;
}

export function redactText(input: string, config: PrivacyConfig): string {
  const rules: RedactionRule[] = [];
  if (config.redactSecrets) {
    rules.push(...BUILTIN_SECRET_RULES);
  }
  if (config.redactEmails) {
    rules.push(EMAIL_RULE);
  }
  rules.push(...compileCustomRules(config));

  if (rules.length === 0) {
    return input;
  }

  return applyRules(input, rules);
}
