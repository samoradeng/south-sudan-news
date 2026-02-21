// AI summarization using Groq (free tier — Llama 3)
// Two modes: quick summaries for feed cards, deep structured articles for detail view
// Rate limit: Groq free tier = 30 RPM. We pace requests with delays + retry on 429.

const Groq = require('groq-sdk');

let groqClient = null;

// Groq free tier: 30 requests/minute. We'll pace to ~20 RPM to be safe.
const REQUEST_DELAY_MS = 3000; // 3s between requests = 20 RPM
const MAX_AI_SUMMARIES = 15; // Only AI-summarize top 15 clusters, rest get extractive
const MAX_RETRIES = 3;

function initGroq(apiKey) {
  if (apiKey) {
    groqClient = new Groq({ apiKey });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry wrapper for Groq API calls with exponential backoff on 429
async function callGroqWithRetry(params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await groqClient.chat.completions.create(params);
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429 && attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.log(`  Rate limited, waiting ${waitMs / 1000}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

// ─── Quick summary (for feed cards) ────────────────────────────

async function summarizeCluster(cluster) {
  if (!groqClient) {
    return extractiveSummary(cluster);
  }

  try {
    const articlesText = cluster.articles
      .slice(0, 5)
      .map((a) => `[${a.source}] ${a.title}\n${a.description}`)
      .join('\n\n');

    const response = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content:
            'You are a concise news summarizer for South Sudan news. Synthesize the provided articles into a brief, factual summary. Include key facts, names, and numbers. Write 2-3 sentences max. Do not editorialize.',
        },
        {
          role: 'user',
          content: `Summarize these related articles about the same story:\n\n${articlesText}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || extractiveSummary(cluster);
  } catch (err) {
    console.warn(`AI summarization failed: ${err.message}`);
    return extractiveSummary(cluster);
  }
}

function extractiveSummary(cluster) {
  const best = cluster.articles
    .filter((a) => a.description && a.description.length > 50)
    .sort((a, b) => b.description.length - a.description.length)[0];

  return best?.description || cluster.primaryArticle.description || cluster.primaryArticle.title;
}

async function summarizeClusters(clusters) {
  const results = [];

  // AI-summarize top clusters one at a time with delays to respect rate limit
  const aiCount = Math.min(clusters.length, MAX_AI_SUMMARIES);
  console.log(`AI-summarizing top ${aiCount} of ${clusters.length} clusters (pacing: ${REQUEST_DELAY_MS / 1000}s between requests)...`);

  for (let i = 0; i < clusters.length; i++) {
    if (i < aiCount && groqClient) {
      // AI summary with rate-limit pacing
      const summary = await summarizeCluster(clusters[i]);
      results.push({ ...clusters[i], summary });

      // Delay before next request (skip after last one)
      if (i < aiCount - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    } else {
      // Extractive summary for remaining clusters (instant, no API call)
      const summary = extractiveSummary(clusters[i]);
      results.push({ ...clusters[i], summary });
    }
  }

  console.log(`Summarization complete: ${aiCount} AI + ${clusters.length - aiCount} extractive`);
  return results;
}

// ─── Deep structured summary (for story detail view) ──────────

async function deepSummarizeCluster(cluster) {
  if (!groqClient) {
    return fallbackDeepSummary(cluster);
  }

  try {
    const articles = cluster.articles.slice(0, 6);
    const articlesText = articles
      .map(
        (a, i) =>
          `Article ${i + 1} [${a.source}]:\nTitle: ${a.title}\n${a.description}`
      )
      .join('\n\n---\n\n');

    const response = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are an expert news analyst writing for a Perplexity-style news platform. Given multiple articles about the same South Sudan story, write a comprehensive, structured analysis.

Format your response EXACTLY like this — use ## for section headings:

## [Descriptive Section Heading]
[1-2 paragraphs synthesizing information. Use **bold** for key names, numbers, organizations, dates, and important facts. At the end of each paragraph, cite which article numbers provided the information using {1} or {1,3} format.]

## [Second Section Heading]
[More paragraphs with **bold** key facts and {source numbers}.]

Rules:
- Write 3-5 sections with descriptive, specific headings (NOT generic like "Background" or "Conclusion")
- Use **bold** liberally for key names, numbers, organizations, places, and important facts
- ALWAYS identify people by their FULL NAME, title/role, and affiliation when mentioned in any article
- If this is a profile, interview, or Q&A article, the primary subject's full name and role MUST appear prominently in the first section
- Cite article numbers at the end of each paragraph using {N} or {N,M} format
- Each section should be 1-2 substantial paragraphs
- Synthesize across sources — don't just repeat each article
- Be factual and journalistic — no editorializing
- Include specific details: names, dates, numbers, locations, quotes when available
- Never say "the article discusses" or "an artist" — use actual names from the articles`,
        },
        {
          role: 'user',
          content: `Analyze and synthesize these ${articles.length} articles about a South Sudan story:\n\n${articlesText}`,
        },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const rawText = response.choices[0]?.message?.content?.trim();
    if (!rawText) return fallbackDeepSummary(cluster);

    return parseDeepSummary(rawText, articles);
  } catch (err) {
    console.warn(`Deep summarization failed: ${err.message}`);
    return fallbackDeepSummary(cluster);
  }
}

function parseDeepSummary(text, articles) {
  const sections = [];
  const parts = text.split(/^## /m).filter(Boolean);

  for (const part of parts) {
    const lines = part.trim().split('\n');
    const heading = lines[0].trim().replace(/^\*\*|\*\*$/g, '');
    const content = lines.slice(1).join('\n').trim();

    // Extract source citations {1,2,3}
    const citedIndices = new Set();
    const citationRegex = /\{(\d+(?:,\s*\d+)*)\}/g;
    let match;
    while ((match = citationRegex.exec(content))) {
      match[1].split(',').forEach((n) => {
        const idx = parseInt(n.trim()) - 1;
        if (idx >= 0 && idx < articles.length) citedIndices.add(idx);
      });
    }

    // Clean content (remove citation markers but keep everything else)
    const cleanContent = content.replace(/\s*\{(\d+(?:,\s*\d+)*)\}\s*/g, ' ').trim();

    const sectionSources =
      citedIndices.size > 0
        ? [...citedIndices].map((i) => ({
            name: articles[i].source,
            url: articles[i].url,
          }))
        : articles.slice(0, 2).map((a) => ({ name: a.source, url: a.url }));

    if (heading && cleanContent) {
      sections.push({
        heading,
        content: cleanContent,
        sources: sectionSources,
      });
    }
  }

  // Fallback if parsing produced nothing
  if (sections.length === 0) {
    sections.push({
      heading: 'Summary',
      content: text.replace(/\{(\d+(?:,\s*\d+)*)\}/g, '').replace(/^## .+$/gm, '').trim(),
      sources: articles.map((a) => ({ name: a.source, url: a.url })),
    });
  }

  return {
    sections,
    allSources: articles.map((a) => ({
      name: a.source,
      url: a.url,
      image: a.image,
    })),
  };
}

function fallbackDeepSummary(cluster) {
  // Build sections from individual article descriptions
  const sections = cluster.articles
    .filter((a) => a.description && a.description.length > 60)
    .slice(0, 4)
    .map((a) => ({
      heading: a.title,
      content: a.description,
      sources: [{ name: a.source, url: a.url }],
    }));

  if (sections.length === 0) {
    sections.push({
      heading: cluster.primaryArticle.title,
      content: cluster.primaryArticle.description || cluster.primaryArticle.title,
      sources: [{ name: cluster.primaryArticle.source, url: cluster.primaryArticle.url }],
    });
  }

  return {
    sections,
    allSources: cluster.articles.map((a) => ({
      name: a.source,
      url: a.url,
      image: a.image,
    })),
  };
}

// ─── Follow-up question answering ─────────────────────────────

async function answerFollowUp(cluster, question, deepSummary) {
  if (!groqClient) {
    return 'AI follow-up questions require a Groq API key. Add GROQ_API_KEY to your .env file.';
  }

  try {
    const articles = cluster.articles.slice(0, 5);
    let context = articles
      .map((a) => `[${a.source}] ${a.title}\n${a.description}`)
      .join('\n\n');

    // Include deep summary for richer context (has synthesized names, details)
    if (deepSummary && deepSummary.sections) {
      context += '\n\n--- Analysis ---\n';
      context += deepSummary.sections
        .map((s) => `${s.heading}\n${s.content}`)
        .join('\n\n');
    }

    const response = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful news analyst specializing in South Sudan and the Horn of Africa. Answer questions based ONLY on the provided articles and analysis. Be concise and factual. Use **bold** for key facts — especially names, dates, and figures. Always use specific names (never say "the artist" or "the official" if a name is available). If the provided text does not contain enough information to answer, say: "This detail isn\'t available in the source articles — check the original source for more."',
        },
        {
          role: 'user',
          content: `Based on these articles:\n\n${context}\n\nQuestion: ${question}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || 'Unable to generate an answer.';
  } catch (err) {
    console.warn(`Follow-up failed: ${err.message}`);
    return 'Failed to generate answer. Please try again.';
  }
}

module.exports = {
  initGroq,
  extractiveSummary,
  summarizeClusters,
  summarizeCluster,
  deepSummarizeCluster,
  answerFollowUp,
};
