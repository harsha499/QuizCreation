const games = {};

const ROUNDS = [
  {
    label: "Agentic AI Framework",
    title: "Agentic AI — Autonomous Task Execution",
    desc: "An AI agent perceives goals, plans multi-step tasks, calls tools, and loops until done. Fill in the 6 key layers.",
    slots: [
      { id: "llm", label: "Core Reasoning", answer: "LLM (GPT-4o)" },
      { id: "orchestrator", label: "Orchestrator", answer: "LangGraph / CrewAI" },
      { id: "tools", label: "Tool Layer", answer: "Function Calling" },
      { id: "memory", label: "Memory Store", answer: "Vector DB" },
      { id: "obs", label: "Observability", answer: "LangSmith / Langfuse" },
      { id: "env", label: "Environment", answer: "Serverless (AWS Lambda)" }
    ],
    cards: [
      { id: "gpt4o", label: "LLM (GPT-4o)" },
      { id: "langgraph", label: "LangGraph / CrewAI" },
      { id: "fnc", label: "Function Calling" },
      { id: "vecdb", label: "Vector DB" },
      { id: "langsmith", label: "LangSmith / Langfuse" },
      { id: "lambda", label: "Serverless (AWS Lambda)" },
      { id: "redis", label: "Redis Cache" },
      { id: "kafka", label: "Kafka Streams" },
      { id: "rest", label: "REST API Gateway" }
    ]
  },
  {
    label: "RAG Framework",
    title: "Retrieval-Augmented Generation (RAG)",
    desc: "RAG grounds LLM responses in your private data. Complete the end-to-end pipeline with 6 components.",
    slots: [
      { id: "ingest", label: "Data Ingestion", answer: "Document Loader" },
      { id: "chunk", label: "Chunking", answer: "Text Splitter" },
      { id: "embed", label: "Embeddings", answer: "Embedding Model" },
      { id: "store", label: "Vector Store", answer: "Pinecone / Weaviate" },
      { id: "retrieve", label: "Retrieval", answer: "Semantic Search" },
      { id: "gen", label: "Generation", answer: "LLM + Prompt Template" }
    ],
    cards: [
      { id: "docloader", label: "Document Loader" },
      { id: "splitter", label: "Text Splitter" },
      { id: "embmod", label: "Embedding Model" },
      { id: "pinecone", label: "Pinecone / Weaviate" },
      { id: "semsearch", label: "Semantic Search" },
      { id: "llmtpl", label: "LLM + Prompt Template" },
      { id: "sql", label: "SQL Database" },
      { id: "bm25", label: "BM25 Keyword Search" },
      { id: "graphdb", label: "Graph Database" }
    ]
  },
  {
    label: "Generative AI Platform",
    title: "Production Generative AI Platform",
    desc: "A scalable GenAI product needs more than a model. Identify the 6 platform layers to ship responsibly.",
    slots: [
      { id: "ui", label: "User Interface", answer: "React / Next.js" },
      { id: "api", label: "API Layer", answer: "FastAPI / Express" },
      { id: "model", label: "Model Provider", answer: "Anthropic / OpenAI" },
      { id: "guard", label: "Safety & Guardrails", answer: "Guardrails AI / NeMo" },
      { id: "cache", label: "Semantic Cache", answer: "GPTCache / Redis" },
      { id: "monitor", label: "Monitoring", answer: "Prometheus + Grafana" }
    ],
    cards: [
      { id: "react", label: "React / Next.js" },
      { id: "fastapi", label: "FastAPI / Express" },
      { id: "anthropic", label: "Anthropic / OpenAI" },
      { id: "guardrails", label: "Guardrails AI / NeMo" },
      { id: "gptcache", label: "GPTCache / Redis" },
      { id: "prom", label: "Prometheus + Grafana" },
      { id: "dynamo", label: "DynamoDB" },
      { id: "spark", label: "Apache Spark" },
      { id: "dbt", label: "dbt Transforms" }
    ]
  }
];

function createGame(code) {
  games[code] = {
    players: [],
    teams: { a: null, b: null },
    scores: { a: 0, b: 0 },
    boards: { a: {}, b: {} },
    currentRound: 0,
    rounds: ROUNDS,
    status: "waiting",
    teamSubmitted: { a: false, b: false }
  };
}

function joinGame(code, player) {
  const game = games[code];
  if (!game) return null;

  if (game.players.length >= 2) return "FULL";

  game.players.push(player);
  // assign team: first -> a, second -> b
  if (!game.teams.a) game.teams.a = player;
  else if (!game.teams.b) game.teams.b = player;

  if (game.players.length === 2) {
    game.status = "playing";
  }

  return game;
}

function placeCard(code, team, slotId, cardId) {
  const game = games[code];
  if (!game) return null;
  game.boards[team][slotId] = cardId;
  return game;
}

function submitTeam(code, team) {
  const game = games[code];
  if (!game) return null;

  const round = game.rounds[game.currentRound];
  const placed = game.boards[team] || {};
  let pts = 0;
  const slotResults = {};

  round.slots.forEach(s => {
    const placedId = placed[s.id];
    const correctCard = round.cards.find(c => c.label === s.answer);
    const isCorrect = placedId && correctCard && placedId === correctCard.id;
    slotResults[s.id] = { correct: !!isCorrect, placed: placedId || null, expected: correctCard ? correctCard.id : null };
    if (isCorrect) pts++;
  });

  game.scores[team] += pts;
  game.teamSubmitted[team] = true;

  const both = game.teamSubmitted.a && game.teamSubmitted.b;

  if (both) {
    // advance round or end game
    game.currentRound++;
    game.boards = { a: {}, b: {} };
    game.teamSubmitted = { a: false, b: false };
    if (game.currentRound >= game.rounds.length) {
      game.status = 'finished';
    }
  }

  return { game, slotResults, pts, both, finished: game.status === 'finished' };
}

function getGame(code) {
  return games[code];
}

function getRoundData(code) {
  const game = games[code];
  if (!game) return null;
  return { index: game.currentRound, round: game.rounds[game.currentRound] };
}

module.exports = {
  createGame,
  joinGame,
  getGame,
  placeCard,
  submitTeam,
  getRoundData
};