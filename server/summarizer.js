// AI summarization using Groq (free tier — Llama 3)
// Falls back gracefully to description extraction if no API key

const Groq = require('groq-sdk');

let groqClient = null;

function initGroq(apiKey) {
  if (apiKey) {
    groqClient = new Groq({ apiKey });
  }
}

async function summarizeCluster(cluster) {
  // If no AI available, use extractive summary
  if (!groqClient) {
    return extractiveSummary(cluster);
  }

  try {
    const articlesText = cluster.articles
      .slice(0, 5) // Limit to 5 articles to stay within token limits
      .map((a, i) => `[${a.source}] ${a.title}\n${a.description}`)
      .join('\n\n');

    const response = await groqClient.chat.completions.create({
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
  // Fallback: use the longest description from the highest-reliability source
  const best = cluster.articles
    .filter((a) => a.description && a.description.length > 50)
    .sort((a, b) => b.description.length - a.description.length)[0];

  return best?.description || cluster.primaryArticle.description || cluster.primaryArticle.title;
}

async function summarizeClusters(clusters) {
  // Process in batches of 3 to respect rate limits
  const results = [];
  for (let i = 0; i < clusters.length; i += 3) {
    const batch = clusters.slice(i, i + 3);
    const summaries = await Promise.all(
      batch.map(async (cluster) => {
        const summary = await summarizeCluster(cluster);
        return { ...cluster, summary };
      })
    );
    results.push(...summaries);
  }
  return results;
}

module.exports = { initGroq, summarizeClusters, summarizeCluster };
