import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb, getCompactEvents, getCompactEventById } from "../../core/db.js";
import { saveCompactedMessages } from "../../core/memory-editor.js";
import { header, fmtDate, fmtTokens, roleIcon, outputJson, severity, divider, printSuccess, printError } from "../format.js";
import type { MessageEntry } from "../../core/jsonl-parser.js";

interface CompactsOptions {
  agent?: string;
  session?: string;
  last?: number;
  showMessages?: boolean;
  save?: string;
  json?: boolean;
}

export async function runCompacts(cfg: ResolvedConfig, opts: CompactsOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  // --save <id>: save a compact event's messages to memory
  if (opts.save !== undefined) {
    const compactId = parseInt(opts.save, 10);
    if (isNaN(compactId)) {
      printError(`Invalid compact ID: ${opts.save}`);
      process.exit(1);
    }
    const event = getCompactEventById(db, compactId);
    if (!event) {
      printError(`Compact event #${compactId} not found.`);
      process.exit(1);
    }
    const messages: MessageEntry[] = event.compacted_messages
      ? JSON.parse(event.compacted_messages) as MessageEntry[]
      : [];
    if (messages.length === 0) {
      console.log(severity.muted("  No messages to save for this compact event."));
      return;
    }
    const memFile = path.join(cfg.workspaceDir, cfg.probe.memory.defaultFile);
    const relFile = path.relative(cfg.workspaceDir, memFile);
    const label = event.compacted_at ? fmtDate(event.compacted_at) : `compact-${compactId}`;
    saveCompactedMessages(memFile, messages, label);
    printSuccess(`Saved ${messages.length} messages from compact #${compactId} to ${relFile}`);
    return;
  }

  const limit = opts.last ?? 5;
  const events = getCompactEvents(db, agent, limit, opts.session);

  if (opts.json) {
    outputJson(
      events.map((e) => ({
        id: e.id,
        sessionKey: e.session_key,
        compactionEntryId: e.compaction_entry_id,
        tokensBefore: e.tokens_before,
        compactedAt: e.compacted_at,
        compactedMessageCount: e.compacted_message_count,
        summaryText: e.summary_text,
        compactedMessages: e.compacted_messages
          ? JSON.parse(e.compacted_messages)
          : [],
      }))
    );
    return;
  }

  header("📦", `Compact Events`, `last ${limit}`);

  if (events.length === 0) {
    console.log(severity.muted("  No compact events recorded yet."));
    console.log();
    return;
  }

  for (const [i, event] of events.entries()) {
    const compactedMessages: Array<{ role: string; content: string; id: string }> =
      event.compacted_messages ? JSON.parse(event.compacted_messages) : [];

    const when = event.compacted_at ? fmtDate(event.compacted_at) : "unknown time";
    const count = event.compacted_message_count ?? compactedMessages.length;

    console.log();
    console.log(`  ${severity.bold(`#${event.id}`)}  ${when}  ${severity.muted("[" + event.session_key.slice(0, 10) + "…]")}`);
    console.log();
    console.log(`    ${count} messages compacted`);
    if (event.tokens_before) {
      console.log(`    Tokens before: ${fmtTokens(event.tokens_before)}`);
    }

    if (compactedMessages.length > 0) {
      console.log();
      console.log(severity.muted("    Compacted messages:"));
      const preview = opts.showMessages ? compactedMessages : compactedMessages.slice(0, 4);
      for (const msg of preview) {
        const icon = roleIcon(msg.role);
        const text = msg.content.slice(0, 120).replace(/\n/g, " ");
        console.log(`      ${icon}  "${text}${msg.content.length > 120 ? "…" : ""}"`);
      }
      if (!opts.showMessages && compactedMessages.length > 4) {
        console.log(severity.muted(`      … and ${compactedMessages.length - 4} more messages`));
      }
    }

    if (event.summary_text) {
      console.log();
      console.log(severity.muted("    Summary generated:"));
      const summaryPreview = event.summary_text.slice(0, 200).replace(/\n/g, " ");
      console.log(`      "${summaryPreview}${event.summary_text.length > 200 ? "…" : ""}"`);
    }

    console.log();
    console.log(`    ${severity.muted("→ Save to memory:")} clawprobe compacts --save ${event.id}`);

    if (i < events.length - 1) {
      console.log();
      divider();
    }
  }

  console.log();
}
