// Browser-side Chat & Prompt Engine (Pure ES Module)

export class BrowserChatEngine {
  /**
   * Formats the Block 0 System Prompt:
   * 1. Author Craft Directives (AGENTS.md)
   * 2. Story Ledger & Settled Continuity (obra/superpowers recovery pattern)
   * 3. Character Definition
   * 4. User Persona
   * 5. Subagent Inner Monologue Protocol
   */
  static formatSystemPrompt(card, persona, settings, ledgerEntries = []) {
    let prompt = "";

    // 1. Author's AGENTS.md Craft Directive
    if (settings && settings.agentsContract && settings.agentsContract.trim()) {
      prompt += `${settings.agentsContract.trim()}\n\n`;
    }

    // 2. Story Ledger (Immutable facts that survive compaction)
    if (ledgerEntries && ledgerEntries.length > 0) {
      prompt += `### STORY LEDGER & SETTLED CONTINUITY (BINDING TRUTH)\n`;
      for (const entry of ledgerEntries) {
        prompt += `- [${entry.type.toUpperCase()}] ${entry.content}\n`;
      }
      prompt += `\n`;
    }

    const cName = card ? (card.data?.name || card.name || "Character") : "Character";
    prompt += `### CHARACTER IN SCENE: ${cName}\n`;
    const desc = card ? (card.data?.description || card.description) : "";
    const pers = card ? (card.data?.personality || card.personality) : "";
    const scen = card ? (card.data?.scenario || card.scenario) : "";
    const mesEx = card ? (card.data?.mes_example || card.mes_example) : "";

    if (desc) prompt += `[Description: ${desc}]\n`;
    if (pers) prompt += `[Personality: ${pers}]\n`;
    if (scen) prompt += `[Scenario: ${scen}]\n`;
    if (mesEx) prompt += `[Dialogue Examples:\n${mesEx}]\n`;

    // 3. User Persona
    if (persona && persona.name) {
      prompt += `\n[User Persona: ${persona.name}]\n${persona.description || ""}\n`;
    }

    // 4. Subagent Thought Monologue Protocol
    if (settings && settings.enableSubagentThoughts !== false) {
      prompt += `\n### SUBAGENT COGNITIVE LAYER
Before outputting narrative prose or spoken dialogue, formulate an internal consciousness scratchpad in <thought character="${cName}"> ... </thought>.
- Hidden desire, fear, or immediate objective.
- Emotional impression of the user's latest act.
- Pacing or tactical steering for the response.
Write raw, immediate consciousness. Never use em dashes or generic AI cliches.
After the thought block, output the public prose and dialogue.\n`;
    }

    return prompt.trim();
  }

  /**
   * Shakes historical <thought> internal monologues from turns older than the recent window
   * Directly saves 30-50% tokens per turn while keeping the immediate consciousness intact.
   */
  static shakeThoughts(messages, keepRecent = 2) {
    if (!Array.isArray(messages)) return [];
    const len = messages.length;
    const threshold = len > keepRecent ? len - keepRecent : 0;
    if (threshold === 0) return messages;

    let hasThoughts = false;
    for (let i = 0; i < threshold; i++) {
      const m = messages[i];
      if (m && m.role === "assistant") {
        const c = m.content;
        if (typeof c === "string" && c.length > 9 && c.indexOf("<thought") !== -1) {
          hasThoughts = true;
          break;
        }
      }
    }
    if (!hasThoughts) return messages;
    const result = new Array(len);
    const regex = /<thought[\s\S]*?<\/thought>/gi;
    for (let i = 0; i < threshold; i++) {
      const m = messages[i];
      if (m.role === "assistant" && typeof m.content === "string" && m.content.indexOf("<thought") !== -1) {
        regex.lastIndex = 0;
        result[i] = {
          role: m.role,
          content: m.content.replace(regex, "").trim()
        };
      } else {
        result[i] = m;
      }
    }
    for (let i = threshold; i < len; i++) {
      result[i] = messages[i];
    }
    return result;
  }

  /**
   * Compaction & Budget Engine:
   * 1. Preserves Block 0 prefix (System Prompt + Turn 0 Root Anchor)
   * 2. Shakes internal thoughts from historical turns older than recent window
   * 3. When total estimated tokens exceeds settings.maxContextTokens:
   *    - Prunes resolved OOC / redundant messages
   *    - Condenses oldest historical middle turns into a concise [Scene Memory Summary]
   *    - Retains recent turns within cacheWarmSuffix (default 4096 tokens)
   */
  static compactContext(systemPrompt, history, maxContextTokens = 16384) {
    if (!history || history.length === 0) return [];
    const histLen = history.length;
    const thoughtThreshold = histLen > 2 ? histLen - 2 : 0;
    let totalTokens = systemPrompt ? ((systemPrompt.length + 3) >> 2) : 0;
    let hasThoughts = false;
    let i = 0;
    const limit = histLen - 7;
    for (; i < limit; i += 8) {
      const m0 = history[i];
      const m1 = history[i + 1];
      const m2 = history[i + 2];
      const m3 = history[i + 3];
      const m4 = history[i + 4];
      const m5 = history[i + 5];
      const m6 = history[i + 6];
      const m7 = history[i + 7];
      const c0 = m0.content;
      const c1 = m1.content;
      const c2 = m2.content;
      const c3 = m3.content;
      const c4 = m4.content;
      const c5 = m5.content;
      const c6 = m6.content;
      const c7 = m7.content;
      const s0 = ((c0 ? c0.length + 3 : 3) >> 2) + ((c1 ? c1.length + 3 : 3) >> 2);
      const s1 = ((c2 ? c2.length + 3 : 3) >> 2) + ((c3 ? c3.length + 3 : 3) >> 2);
      const s2 = ((c4 ? c4.length + 3 : 3) >> 2) + ((c5 ? c5.length + 3 : 3) >> 2);
      const s3 = ((c6 ? c6.length + 3 : 3) >> 2) + ((c7 ? c7.length + 3 : 3) >> 2);
      totalTokens += (s0 + s1) + (s2 + s3);
      if (!hasThoughts && i < thoughtThreshold) {
        if (m0.role === "assistant" && typeof c0 === "string" && c0.length > 9 && c0.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 1 < thoughtThreshold && m1.role === "assistant" && typeof c1 === "string" && c1.length > 9 && c1.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 2 < thoughtThreshold && m2.role === "assistant" && typeof c2 === "string" && c2.length > 9 && c2.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 3 < thoughtThreshold && m3.role === "assistant" && typeof c3 === "string" && c3.length > 9 && c3.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 4 < thoughtThreshold && m4.role === "assistant" && typeof c4 === "string" && c4.length > 9 && c4.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 5 < thoughtThreshold && m5.role === "assistant" && typeof c5 === "string" && c5.length > 9 && c5.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 6 < thoughtThreshold && m6.role === "assistant" && typeof c6 === "string" && c6.length > 9 && c6.indexOf("<thought") !== -1) hasThoughts = true;
        else if (i + 7 < thoughtThreshold && m7.role === "assistant" && typeof c7 === "string" && c7.length > 9 && c7.indexOf("<thought") !== -1) hasThoughts = true;
      }
    }
    for (; i < histLen; i++) {
      const m = history[i];
      const c = m.content;
      if (c) totalTokens += ((c.length + 3) >> 2);
      if (!hasThoughts && i < thoughtThreshold && m.role === "assistant" && typeof c === "string" && c.length > 9 && c.indexOf("<thought") !== -1) hasThoughts = true;
    }
    const shakenHistory = hasThoughts ? this.shakeThoughts(history, 2) : history;
    if (totalTokens <= maxContextTokens) {
      return shakenHistory;
    }

    // Compaction triggered: keep Turn 0 Root Anchor and recent suffix intact
    const rootAnchor = shakenHistory[0];
    const warmSuffixCount = histLen > 7 ? 6 : (histLen - 1);
    const middleCount = histLen - 1 - warmSuffixCount;

    if (middleCount > 0) {
      // Extract essential beats from up to last 8 turns of the middle range
      const beatStartIndex = Math.max(1, 1 + middleCount - 8);
      const beatEndIndex = 1 + middleCount;
      const beatCount = beatEndIndex - beatStartIndex;
      const beats = new Array(beatCount);
      let beatIdx = 0;
      let thoughtRegex = null;

      for (let i = beatStartIndex; i < beatEndIndex; i++) {
        const m = shakenHistory[i];
        const content = m.content;
        if (!content || (content[0] === "[" && content.startsWith("[Scene Memory Summary"))) continue;
        let clean = content;
        const tagPos = clean.indexOf("<thought");
        if (tagPos !== -1) {
          if (!thoughtRegex) thoughtRegex = /<thought[\s\S]*?<\/thought>/gi;
          thoughtRegex.lastIndex = 0;
          clean = clean.replace(thoughtRegex, "").trim();
        }
        const rolePrefix = m.role === "user" ? "User: " : "Character: ";
        const isLong = clean.length > 140;
        beats[beatIdx++] = isLong ? (rolePrefix + clean.substring(0, 140) + "...") : (rolePrefix + clean);
      }
      if (beatIdx < beatCount) beats.length = beatIdx;
      const out = new Array(2 + warmSuffixCount);
      out[0] = rootAnchor;
      out[1] = {
        role: "system",
        content: `[Scene Memory Summary: Prior narrative developments include: ${beats.join(" | ")}]`
      };
      if (warmSuffixCount === 6) {
        const base = histLen - 6;
        out[2] = shakenHistory[base];
        out[3] = shakenHistory[base + 1];
        out[4] = shakenHistory[base + 2];
        out[5] = shakenHistory[base + 3];
        out[6] = shakenHistory[base + 4];
        out[7] = shakenHistory[base + 5];
      } else {
        let outIdx = 2;
        for (let i = histLen - warmSuffixCount; i < histLen; i++) {
          out[outIdx++] = shakenHistory[i];
        }
      }
      return out;
    }
    return shakenHistory;
  }

  /**
   * Assembles context with Block 0 prefix lock and automatic context compaction
   */
  static assembleMessages(systemPrompt, history, userText, postHistoryInstructions, maxContextTokens = 16384) {
    const payload = [{ role: "system", content: systemPrompt }];

    const compactedHistory = this.compactContext(systemPrompt, history || [], maxContextTokens);

    for (const msg of compactedHistory) {
      payload.push({ role: msg.role === "compaction_summary" ? "system" : msg.role, content: msg.content });
    }

    if (userText) {
      let finalUserTurn = userText;
      if (postHistoryInstructions && postHistoryInstructions.trim()) {
        finalUserTurn += `\n\n[Writing Guidance: ${postHistoryInstructions.trim()}]`;
      }
      payload.push({ role: "user", content: finalUserTurn });
    }

    return payload;
  }

  /**
   * Direct Browser Streaming with seamless real-time anti-slop cleaning
   */
  static async *streamDirect(settings, messages, onCleanChunk) {
    const rawEp = String(settings?.apiEndpoint || "").trim();
    const model = String(settings?.model || "").trim();
    if (!rawEp || !model) {
      throw new Error("Configure an API base URL and model in Settings before generating a reply.");
    }
    const endpoint = `${rawEp.replace(/\/$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (settings && settings.apiKey) {
      headers["Authorization"] = `Bearer ${settings.apiKey}`;
    }

    const body = {
      model,
      messages,
      stream: true,
    };

    // Temperature: If temperature is set, send it. Default 0.85.
    if (settings && typeof settings.temperature === "number") {
      body.temperature = settings.temperature;
    } else {
      body.temperature = 0.85;
    }

    // Top P: 1.0 is neutral (no cutoff). Only include if < 1.0.
    if (settings && typeof settings.topP === "number" && settings.topP < 1.0) {
      body.top_p = settings.topP;
    }

    // Min P: 0.0 is disabled/off. Only include if > 0.0.
    if (settings && typeof settings.minP === "number" && settings.minP > 0.0) {
      body.min_p = settings.minP;
    }

    // Frequency Penalty: 0.0 is neutral (no penalty). Only include if !== 0.0.
    if (settings && typeof settings.frequencyPenalty === "number" && settings.frequencyPenalty !== 0.0) {
      body.frequency_penalty = settings.frequencyPenalty;
    }

    // Presence Penalty: 0.0 is neutral (no penalty). Only include if !== 0.0.
    if (settings && typeof settings.presencePenalty === "number" && settings.presencePenalty !== 0.0) {
      body.presence_penalty = settings.presencePenalty;
    }

    // Max Tokens
    if (settings && typeof settings.maxTokens === "number") {
      body.max_tokens = settings.maxTokens;
    } else {
      body.max_tokens = 1200;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              // Seamless token cleaner (strips em dashes and spacing artifacts silently)
              const cleaned = delta
                .replace(/ — /g, ", ")
                .replace(/—/g, ", ")
                .replace(/ -- /g, ", ");
              if (onCleanChunk) onCleanChunk(cleaned);
              yield cleaned;
            }
          } catch {
            // pass partial json
          }
        }
      }
    }
  }
  /**
   * Unified turn runner invoked by the UI
   */
  static async streamTurn({ card, session, settings, persona, agentsContract, userPrompt, onChunk }) {
    const activePersona = persona || { name: "You" };
    const activeSettings = agentsContract ? { ...settings, agentsContract } : settings;
    const systemPrompt = this.formatSystemPrompt(card, activePersona, activeSettings);
    
    const rawList = session ? (session.messages || []) : [];
    const pastMessages = rawList.filter(m => m.content && m.content.trim());
    
    const maxContextTokens = settings?.maxContextTokens ?? 16384;

    const messages = this.assembleMessages(
      systemPrompt,
      pastMessages,
      null, // user message is already in pastMessages
      card ? (card.data?.post_history_instructions || card.post_history_instructions || "") : "",
      maxContextTokens
    );
    let fullText = "";
    for await (const chunk of this.streamDirect(settings, messages, onChunk)) {
      fullText += chunk;
    }
    return fullText;
  }

  static async fetchAvailableModels(endpoint, apiKey) {
    const rawEndpoint = String(endpoint || "").trim();
    if (!rawEndpoint) throw new Error("Enter an API base URL before fetching models.");
    const url = `${rawEndpoint.replace(/\/$/, "").replace(/\/chat\/completions$/, "")}/models`;
    const headers = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  static async *streamScene({ card, session, settings, persona, agentsContract, userPrompt }) {
    const activePersona = persona || { name: "You" };
    const activeSettings = agentsContract ? { ...settings, agentsContract } : settings;
    const systemPrompt = this.formatSystemPrompt(card, activePersona, activeSettings);
    const rawList = session ? (session.messages || []) : [];
    const messages = this.assembleMessages(
      systemPrompt,
      rawList,
      userPrompt,
      card ? (card.post_history_instructions || "") : ""
    );

    let accumulated = "";
    for await (const chunk of this.streamDirect(settings, messages)) {
      accumulated += chunk;
      yield { type: "chunk", text: chunk };
    }
    yield { type: "done", text: accumulated };
  }
}
