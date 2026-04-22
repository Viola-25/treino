// ==UserScript==
// @name         MedCof Flashcard IA Session Bot (Groq)
// @namespace    treino.flashcards.ai
// @version      1.0.3
// @description  Automatiza sessao de flashcards com classificacao IA (facil/medio/dificil) e relatorio final.
// @author       You
// @match        https://qbank-prime.medcof.com.br/*
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://api.groq.com/openai/v1/chat/completions";
  const DEFAULT_MODEL = "llama-3.1-8b-instant";
  const STORAGE_KEY = "flashcard_bot_groq_api_key";
  const MAX_RETRIES = 2;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalize = (value) =>
    (value || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const clickElement = (el) => {
    if (!el) return false;

    const target =
      el.closest?.("button, [role='button'], a, div, span") || el;

    if (typeof target.click === "function") {
      target.click();
    }

    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });

    return true;
  };

  const getClickableByLabel = (matcher) => {
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], a, div, span")
    ).filter(isVisible);

    return candidates.find((el) => {
      const text = normalize(el.textContent || "");
      return matcher(text);
    });
  };

  const getRevealButton = () =>
    getClickableByLabel((text) =>
      text.includes("ver resposta") || text.includes("ver questao")
    );

  const getFlipCard = () => {
    const candidates = Array.from(document.querySelectorAll("[class*='flip-card']")).filter(isVisible);
    return candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 500 && rect.height > 280;
    });
  };

  const isQuestionSideVisible = () => {
    const card = getFlipCard();
    if (!card) return false;
    const hasBack = card.classList.toString().includes("flip-card-back");
    const reveal = getRevealButton();
    if (!reveal) return false;
    const buttonText = normalize(reveal.textContent || "");
    return buttonText.includes("ver resposta") || !hasBack;
  };

  const isAnswerSideVisible = () => {
    const card = getFlipCard();
    if (!card) return false;
    const hasBack = card.classList.toString().includes("flip-card-back");
    const reveal = getRevealButton();
    if (!reveal) return false;
    const buttonText = normalize(reveal.textContent || "");
    return (buttonText.includes("ver questao") || hasBack) && !buttonText.includes("ver resposta");
  };

  const getDifficultyButton = (difficulty) => {
    const target = normalize(difficulty);

    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], a, div, span")
    )
      .filter(isVisible)
      .map((el) => {
        const text = normalize(el.textContent || "");
        const rect = el.getBoundingClientRect();
        let score = 0;

        if (text === target) score += 130;
        if (text.startsWith(`${target} `)) score += 120;
        if (new RegExp(`(^|\\s)${target}(\\s|$)`).test(text)) score += 110;
        if (text.includes(target)) score += 90;

        // Os botoes corretos ficam no rodape do card.
        if (rect.y > window.innerHeight * 0.45) score += 25;
        if (rect.width >= 80) score += 10;

        return { el, text, score };
      })
      .filter((x) => x.score >= 110)
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

    return candidates[0]?.el || null;
  };

  const findCardContainer = () => {
    const reveal = getRevealButton();
    if (!reveal) return null;

    let node = reveal;
    for (let i = 0; i < 14 && node; i += 1) {
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (rect && rect.width > 500 && rect.height > 280) {
        return node;
      }
      node = node.parentElement;
    }

    return reveal.closest("main") || document.body;
  };

  const stripNoiseLines = (text) => {
    const noise = [
      "dashboard",
      "qbank",
      "flashcards",
      "aulas",
      "ver resposta",
      "ver questao",
      "errei",
      "dificil",
      "medio",
      "facil",
      "a+",
      "a-",
    ];

    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const n = normalize(line);
        return !noise.includes(n);
      })
      .join("\n");
  };

  const extractCardText = () => {
    const container = findCardContainer();
    if (!container) return "";

    const clone = container.cloneNode(true);
    clone
      .querySelectorAll("button, [role='button'], svg, img, nav, aside, header, footer")
      .forEach((el) => el.remove());

    const raw = (clone.innerText || "").trim();
    return stripNoiseLines(raw);
  };

  const waitFor = async (predicate, timeoutMs = 7000, pollMs = 120) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await sleep(pollMs);
    }
    return false;
  };

  const getQuestionText = () => {
    const text = extractCardText();
    const lines = text
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length >= 8);

    if (!lines.length) return "";

    const withQuestionMark = lines.filter((line) => line.includes("?"));
    if (withQuestionMark.length) {
      return withQuestionMark.sort((a, b) => b.length - a.length)[0];
    }

    return lines.sort((a, b) => b.length - a.length)[0];
  };

  const getAnswerText = (questionText) => {
    const questionNormalized = normalize(questionText || "");
    const text = extractCardText();
    const lines = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((line) => normalize(line) !== questionNormalized);

    return lines.join("\n");
  };

  const ensureQuestionSide = async () => {
    if (isQuestionSideVisible()) return true;

    const reveal = getRevealButton();
    if (!reveal) return false;

    clickElement(reveal);
    return waitFor(() => isQuestionSideVisible(), 6000);
  };

  const openAnswerSide = async () => {
    if (isAnswerSideVisible()) return true;

    const reveal = getRevealButton();
    if (!reveal) return false;

    clickElement(reveal);
    await sleep(300);
    clickElement(reveal);
    return waitFor(() => isAnswerSideVisible(), 7000, 200);
  };

  const extractQuestionFromCardText = (cardText) => {
    const lines = cardText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!lines.length) return "";

    const questionLine = lines.find((line) => /\?$/.test(line));
    if (questionLine) return questionLine;

    return lines[0];
  };

  const getApiKey = () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;

    const typed = window.prompt("Cole sua API key da Groq:");
    if (!typed || !typed.trim()) return null;

    localStorage.setItem(STORAGE_KEY, typed.trim());
    return typed.trim();
  };

  const askGroqForDifficulty = async ({ apiKey, model, question, answer }) => {
    const prompt = [
      "Voce classifica flashcards medicos pela dificuldade para revisao.",
      "Responda APENAS JSON valido sem markdown.",
      'Formato: {"difficulty":"facil|medio|dificil","rationale":"...","key_points":["..."],"must_know":["..."]}',
      "Regras:",
      "- difficulty deve ser um dos 3 valores permitidos.",
      "- rationale: 1 frase curta.",
      "- key_points: 2 a 4 itens curtos.",
      "- must_know: 2 a 4 itens curtos e praticos.",
      "- Use portugues.",
      "Contexto do flashcard:",
      `Pergunta: ${question || "(nao encontrada)"}`,
      `Conteudo da resposta: ${answer || "(nao encontrado)"}`,
    ].join("\n");

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Falha Groq (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Resposta vazia da Groq.");

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw err;
      parsed = JSON.parse(match[0]);
    }

    const difficulty = normalize(parsed.difficulty);
    const allowed = ["facil", "medio", "dificil"];

    return {
      difficulty: allowed.includes(difficulty) ? difficulty : "medio",
      rationale: String(parsed.rationale || "Sem justificativa."),
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points.map((x) => String(x)).slice(0, 4)
        : [],
      must_know: Array.isArray(parsed.must_know)
        ? parsed.must_know.map((x) => String(x)).slice(0, 4)
        : [],
    };
  };

  const waitForCardChange = async (previousSignature, timeoutMs = 12000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const nowText = extractCardText();
      const nowSignature = normalize(nowText).slice(0, 220);
      if (nowSignature && nowSignature !== previousSignature) return true;
      await sleep(400);
    }
    return false;
  };

  const summarizeMustKnow = (items) => {
    const scores = new Map();
    items.forEach((entry) => {
      (entry.must_know || []).forEach((point) => {
        const key = point.trim();
        if (!key) return;
        scores.set(key, (scores.get(key) || 0) + 1);
      });
    });

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([text, count]) => ({ text, count }));
  };

  const buildMarkdownReport = (sessionData) => {
    const startedAt = new Date(sessionData.startedAt).toLocaleString("pt-BR");
    const endedAt = new Date(sessionData.endedAt).toLocaleString("pt-BR");

    const totals = { facil: 0, medio: 0, dificil: 0 };
    sessionData.cards.forEach((c) => {
      totals[c.difficulty] = (totals[c.difficulty] || 0) + 1;
    });

    const hotMustKnow = summarizeMustKnow(sessionData.cards);

    const lines = [];
    lines.push("# Relatorio da Sessao de Flashcards");
    lines.push("");
    lines.push(`- Inicio: ${startedAt}`);
    lines.push(`- Fim: ${endedAt}`);
    lines.push(`- Total de cards: ${sessionData.cards.length}`);
    lines.push(`- Facil: ${totals.facil}`);
    lines.push(`- Medio: ${totals.medio}`);
    lines.push(`- Dificil: ${totals.dificil}`);
    lines.push("");
    lines.push("## O mais importante para saber");

    if (!hotMustKnow.length) {
      lines.push("- Nao foi possivel extrair pontos-chave.");
    } else {
      hotMustKnow.forEach((item) => lines.push(`- ${item.text} (apareceu ${item.count}x)`));
    }

    lines.push("");
    lines.push("## Cards vistos na sessao");
    lines.push("");

    sessionData.cards.forEach((card, i) => {
      lines.push(`### ${i + 1}. ${card.question || "Pergunta nao identificada"}`);
      lines.push(`- Classificacao: ${card.difficulty}`);
      lines.push(`- Justificativa IA: ${card.rationale}`);
      lines.push("- Principais pontos:");
      if (!card.key_points.length) {
        lines.push("  - (sem pontos)");
      } else {
        card.key_points.forEach((p) => lines.push(`  - ${p}`));
      }
      lines.push("- Must know:");
      if (!card.must_know.length) {
        lines.push("  - (sem pontos)");
      } else {
        card.must_know.forEach((p) => lines.push(`  - ${p}`));
      }
      lines.push("");
    });

    return lines.join("\n");
  };

  const downloadText = (filename, content) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const renderReportModal = (markdownReport, sessionData) => {
    const existing = document.getElementById("flashcard-ai-report-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "flashcard-ai-report-modal";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.55)",
      "z-index:999999",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:16px",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "width:min(980px, 96vw)",
      "max-height:90vh",
      "overflow:auto",
      "background:#111827",
      "color:#f9fafb",
      "border-radius:14px",
      "padding:16px",
      "box-shadow:0 20px 50px rgba(0,0,0,0.4)",
      "font-family: ui-monospace, SFMono-Regular, Menlo, monospace",
    ].join(";");

    const title = document.createElement("h3");
    title.textContent = "Relatorio final da sessao";
    title.style.margin = "0 0 12px";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px";

    const mkBtn = (label, onClick) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = [
        "border:none",
        "border-radius:8px",
        "padding:8px 12px",
        "cursor:pointer",
        "background:#22c55e",
        "color:#052e16",
        "font-weight:700",
      ].join(";");
      btn.addEventListener("click", onClick);
      return btn;
    };

    actions.appendChild(
      mkBtn("Copiar relatorio", async () => {
        await navigator.clipboard.writeText(markdownReport);
        alert("Relatorio copiado para a area de transferencia.");
      })
    );

    actions.appendChild(
      mkBtn("Baixar .md", () => {
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        downloadText(`relatorio-flashcards-${now}.md`, markdownReport);
      })
    );

    actions.appendChild(
      mkBtn("Baixar .json", () => {
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        downloadText(`relatorio-flashcards-${now}.json`, JSON.stringify(sessionData, null, 2));
      })
    );

    const closeBtn = mkBtn("Fechar", () => overlay.remove());
    closeBtn.style.background = "#f43f5e";
    closeBtn.style.color = "#fff";
    actions.appendChild(closeBtn);

    const pre = document.createElement("pre");
    pre.textContent = markdownReport;
    pre.style.cssText = [
      "white-space:pre-wrap",
      "line-height:1.45",
      "font-size:12px",
      "margin:0",
      "background:#0b1220",
      "padding:12px",
      "border-radius:10px",
    ].join(";");

    panel.appendChild(title);
    panel.appendChild(actions);
    panel.appendChild(pre);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  };

  const state = {
    running: false,
    stopRequested: false,
    sessionData: null,
  };

  const setLauncherStatus = (btn, running) => {
    if (!btn) return;
    btn.textContent = running ? "Parar IA" : "Iniciar IA";
    btn.style.background = running ? "#ef4444" : "#16a34a";
  };

  const injectLauncher = () => {
    if (document.getElementById("flashcard-ai-launcher")) return;

    const btn = document.createElement("button");
    btn.id = "flashcard-ai-launcher";
    btn.type = "button";
    btn.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:999998",
      "border:none",
      "border-radius:999px",
      "padding:10px 14px",
      "font-weight:700",
      "font-size:13px",
      "cursor:pointer",
      "color:#fff",
      "box-shadow:0 8px 24px rgba(0,0,0,0.25)",
    ].join(";");

    setLauncherStatus(btn, false);

    btn.addEventListener("click", async () => {
      if (state.running) {
        stop();
        setLauncherStatus(btn, false);
        return;
      }

      setLauncherStatus(btn, true);
      try {
        await start();
      } finally {
        setLauncherStatus(btn, false);
      }
    });

    document.body.appendChild(btn);
  };

  const stop = () => {
    state.stopRequested = true;
    console.warn("[FlashcardBot] Encerrando apos o card atual...");
  };

  const start = async (config = {}) => {
    if (state.running) {
      alert("Bot ja esta rodando.");
      return;
    }

    const apiKey = config.apiKey || getApiKey();
    if (!apiKey) {
      alert("API key nao fornecida.");
      return;
    }

    const totalCards = Number(
      config.totalCards || window.prompt("Quantos flashcards responder nesta sessao?", "10")
    );

    if (!Number.isFinite(totalCards) || totalCards <= 0) {
      alert("Quantidade invalida.");
      return;
    }

    const model = config.model || DEFAULT_MODEL;

    state.running = true;
    state.stopRequested = false;
    state.sessionData = {
      startedAt: Date.now(),
      endedAt: null,
      model,
      cards: [],
      requestedTotal: totalCards,
    };

    console.log(`[FlashcardBot] Iniciando sessao para ${totalCards} cards.`);

    for (let index = 0; index < totalCards; index += 1) {
      if (state.stopRequested) break;

      let retries = 0;
      let done = false;

      while (!done && retries <= MAX_RETRIES) {
        try {
          await sleep(450);

          const questionSideOk = await ensureQuestionSide();
          if (!questionSideOk) {
            throw new Error("Nao consegui exibir o lado da pergunta.");
          }

          const questionRaw = getQuestionText() || extractCardText();
          const question = extractQuestionFromCardText(questionRaw);
          const beforeSignature = normalize(questionRaw).slice(0, 220);

          const answerSideOk = await openAnswerSide();
          if (!answerSideOk) {
            throw new Error("Nao consegui abrir o lado da resposta.");
          }

          await sleep(550);
          const answerText = getAnswerText(question) || extractCardText();

          const ai = await askGroqForDifficulty({
            apiKey,
            model,
            question,
            answer: answerText,
          });

          const levelButton = getDifficultyButton(ai.difficulty);
          if (!levelButton) {
            throw new Error(`Botao de dificuldade nao encontrado para: ${ai.difficulty}`);
          }

          clickElement(levelButton);

          state.sessionData.cards.push({
            index: state.sessionData.cards.length + 1,
            question,
            raw_text: answerText,
            difficulty: ai.difficulty,
            rationale: ai.rationale,
            key_points: ai.key_points,
            must_know: ai.must_know,
            ts: Date.now(),
          });

          console.log(
            `[FlashcardBot] Card ${index + 1}/${totalCards} => ${ai.difficulty.toUpperCase()} | ${question}`
          );

          await waitForCardChange(beforeSignature);
          done = true;
        } catch (err) {
          retries += 1;
          console.warn(`[FlashcardBot] Erro no card ${index + 1}, tentativa ${retries}:`, err);
          await sleep(1200);

          if (retries > MAX_RETRIES) {
            console.error("[FlashcardBot] Pulando card por falhas repetidas.");
            state.sessionData.cards.push({
              index: state.sessionData.cards.length + 1,
              question: "(falha na leitura)",
              raw_text: "",
              difficulty: "medio",
              rationale: `Falha tecnica: ${String(err.message || err)}`,
              key_points: [],
              must_know: [],
              ts: Date.now(),
            });
          }
        }
      }
    }

    state.sessionData.endedAt = Date.now();
    state.running = false;

    const report = buildMarkdownReport(state.sessionData);
    renderReportModal(report, state.sessionData);
    console.log("[FlashcardBot] Sessao finalizada.");
  };

  const api = {
    start,
    stop,
    getSessionData: () => JSON.parse(JSON.stringify(state.sessionData)),
    clearApiKey: () => localStorage.removeItem(STORAGE_KEY),
  };

  window.flashcardAIBot = api;
  globalThis.flashcardAIBot = api;
  if (typeof unsafeWindow !== "undefined") {
    unsafeWindow.flashcardAIBot = api;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectLauncher, { once: true });
  } else {
    injectLauncher();
  }

  console.log("[FlashcardBot] Pronto. Use window.flashcardAIBot.start() ou o botao 'Iniciar IA'.");
})();
