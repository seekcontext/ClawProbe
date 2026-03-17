import { MessageEntry, CompactEvent, getCompactedMessages, JournalEntry } from "../core/jsonl-parser.js";

export interface ImportanceLoss {
  message: MessageEntry;
  score: number;        // 0–1
  reasons: string[];
}

export type SummaryQuality = "good" | "partial" | "poor";

export interface CompactAnalysis {
  event: CompactEvent;
  compactedMessages: MessageEntry[];
  importantLosses: ImportanceLoss[];
  summaryQuality: SummaryQuality;
}

// Patterns that signal important content
const PREFERENCE_PATTERNS = [
  /\b(use|prefer|always|never|don'?t|avoid|must|should|require|need)\b/i,
  /\bnot\s+(use|do|allow|want)\b/i,
  /\binstead\s+of\b/i,
];

const TECHNICAL_PATTERNS = [
  /[./\\][a-zA-Z0-9_-]+\.[a-zA-Z]{1,10}/,     // file paths
  /\b[A-Z_]{2,}\b/,                              // CONSTANTS / env vars
  /`[^`]+`/,                                     // inline code
  /```[\s\S]+?```/,                              // code blocks
  /\b(port|host|url|api|key|token|secret|password|config|env)\b/i,
  /https?:\/\//,                                 // URLs
];

const ENTITY_PATTERNS = [
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/,            // CamelCase names
  /\b(project|repo|database|service|component|module|package)\s+\w+/i,
];

const DECISION_PATTERNS = [
  /\b(decided|agreed|confirmed|settled on|going with|chose|selected)\b/i,
  /\b(the plan is|we will|I will|let's)\b/i,
];

export function scoreLoss(message: MessageEntry, summaryText: string): { score: number; reasons: string[] } {
  if (message.role !== "user" && message.role !== "assistant") {
    return { score: 0, reasons: [] };
  }

  const content = message.content;
  const lowerContent = content.toLowerCase();
  const lowerSummary = summaryText.toLowerCase();

  const reasons: string[] = [];
  let score = 0;

  // Check preference patterns
  for (const pattern of PREFERENCE_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      // Only flag if the surrounding phrase doesn't appear in summary
      const phrase = extractPhrase(content, match.index, 40);
      if (phrase && !lowerSummary.includes(phrase.toLowerCase().slice(0, 20))) {
        score += 0.3;
        reasons.push("Preference or constraint statement");
        break;
      }
    }
  }

  // Check technical content
  for (const pattern of TECHNICAL_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      const val = match[0].slice(0, 30);
      if (!lowerSummary.includes(val.toLowerCase())) {
        score += 0.25;
        reasons.push("Technical detail (code, path, config)");
        break;
      }
    }
  }

  // Check entity mentions
  for (const pattern of ENTITY_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      const val = match[0].toLowerCase();
      if (!lowerSummary.includes(val)) {
        score += 0.2;
        reasons.push("Named entity or project reference");
        break;
      }
    }
  }

  // Check decision language
  for (const pattern of DECISION_PATTERNS) {
    if (pattern.test(content)) {
      score += 0.25;
      reasons.push("Decision or agreement statement");
      break;
    }
  }

  // User messages are generally more important (explicit instructions)
  if (message.role === "user" && score > 0) {
    score = Math.min(score * 1.2, 1.0);
  }

  // Long messages with no keywords — probably just conversation
  if (score === 0 && lowerContent.length > 200) {
    score = 0.05;
    reasons.push("Long message (may contain context)");
  }

  return { score: Math.min(score, 1.0), reasons };
}

export function analyzeCompaction(
  event: CompactEvent,
  allEntries: JournalEntry[],
  previousFirstKeptId?: string
): CompactAnalysis {
  const compactedMessages = getCompactedMessages(allEntries, event, previousFirstKeptId);

  const losses: ImportanceLoss[] = [];

  for (const msg of compactedMessages) {
    const { score, reasons } = scoreLoss(msg, event.summaryText);
    if (score >= 0.2) {
      losses.push({ message: msg, score, reasons });
    }
  }

  // Sort by score descending
  losses.sort((a, b) => b.score - a.score);

  const quality = determineQuality(losses, compactedMessages.length);

  return {
    event,
    compactedMessages,
    importantLosses: losses,
    summaryQuality: quality,
  };
}

function determineQuality(
  losses: ImportanceLoss[],
  totalMessages: number
): SummaryQuality {
  const criticalLosses = losses.filter((l) => l.score >= 0.5).length;
  const moderateLosses = losses.filter((l) => l.score >= 0.2).length;

  if (criticalLosses >= 2 || (totalMessages > 5 && criticalLosses >= 1)) {
    return "poor";
  }
  if (moderateLosses >= 2) {
    return "partial";
  }
  return "good";
}

function extractPhrase(text: string, index: number, maxLen: number): string {
  const start = Math.max(0, index - 10);
  const end = Math.min(text.length, index + maxLen);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
