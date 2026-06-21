/**
 * quizGameManager.js — Backend game engine (single source of truth)
 *
 * BUG FIXES in this version
 * ─────────────────────────
 * BUG 1 — Only 5 of 10 questions appear per round
 *   Root cause: handleAnswer() had a guard `if (game.answered && game.stealUsed) return null`.
 *   After a correct answer both flags become true.  nextQuestion() resets them, but the
 *   guard was checking BEFORE any answer was even evaluated on the new question — because
 *   the flags from the PREVIOUS question were still true at the moment the socket fires
 *   'answer' for the new question.  That caused every even-numbered question to be silently
 *   dropped, making it look like only 5 reached the client.
 *   Fix: the guard now only returns null when the question is genuinely finished AND the
 *   stealUsed flag has been set by THIS question (not a leftover).  We achieve this by
 *   relying on the fact that nextQuestion() always resets both flags to false, so the
 *   guard is simply: if question is already fully resolved (answered===true) → reject.
 *
 * BUG 2 — Wrong team can still click after answering wrong
 *   Root cause: the steal phase re-enabled ALL buttons on the frontend.
 *   Fix: server now includes `activeTeam` in every state snapshot.  The frontend uses
 *   this to enable buttons only for the team that is currently meant to answer.
 *
 * BUG 3 — Both teams can answer simultaneously
 *   Root cause: no per-socket team assignment existed; every click was accepted.
 *   Fix: server tracks `socketTeams` map (socketId → 0|1) on the game object.
 *   handleAnswer() now receives the team index from the socket handler (which looks
 *   up the caller's socket id) and rejects answers from the non-active team.
 *
 * BUG 4 — First-chance order not preserved across questions
 *   Root cause: currentTeam was flipped inside handleAnswer() for the "correct" case
 *   but the flip was ALSO applied during restart/nextQuestion via currentTeam=0.
 *   Fix: game stores `lastWinner` (0 by default = Team A goes first on Q1).
 *   nextQuestion() sets currentTeam = lastWinner so the winner of the previous
 *   question always gets the first chance on the next one.  If both teams miss,
 *   lastWinner is unchanged, so the same team that had the last correct answer
 *   (or Team A at the start) goes first.
 */

// ─── Question bank ────────────────────────────────────────────────────────────
const RAW = [
  // Round 1 — Intermediate
  {r:1,diff:"intermediate",cat:"AI/ML",q:"What is the difference between supervised and unsupervised learning?",opts:["Supervised uses labelled data; unsupervised finds patterns in unlabelled data","Supervised is faster; unsupervised is more accurate","Supervised runs on GPUs; unsupervised on CPUs","Supervised needs the internet; unsupervised works offline"],ans:0},
  {r:1,diff:"intermediate",cat:"AWS",q:"Which AWS service provides a fully managed message pub/sub fanout to multiple subscribers?",opts:["SQS","SNS","EventBridge","Kinesis"],ans:1},
  {r:1,diff:"intermediate",cat:"AI/ML",q:"What does a confusion matrix in classification show?",opts:["Model training time","True/false positives and negatives across predicted vs actual classes","Loss over epochs","Memory usage during inference"],ans:1},
  {r:1,diff:"intermediate",cat:"AWS",q:"What is the main purpose of Amazon SageMaker?",opts:["Manage DNS records","Build, train, and deploy machine learning models","Store object files","Monitor billing"],ans:1},
  {r:1,diff:"intermediate",cat:"AI/ML",q:"Which activation function is most commonly used in hidden layers of deep neural networks today?",opts:["Sigmoid","Tanh","ReLU","Softmax"],ans:2},
  {r:1,diff:"intermediate",cat:"AWS",q:"In AWS, which service is used to cache database query results and reduce latency?",opts:["RDS","DynamoDB Accelerator (DAX)","ElastiCache","Redshift"],ans:2},
  {r:1,diff:"intermediate",cat:"AI/ML",q:"What does 'precision' measure in a classification model?",opts:["Of all actual positives, how many were found","Of all predicted positives, how many were actually positive","Overall model accuracy","Loss on the validation set"],ans:1},
  {r:1,diff:"intermediate",cat:"AWS",q:"Which AWS service lets you run Docker containers without managing servers?",opts:["EC2","EKS","AWS Fargate","Elastic Beanstalk"],ans:2},
  {r:1,diff:"intermediate",cat:"AI/ML",q:"What is the vanishing gradient problem in deep learning?",opts:["Model learns too fast and overfits","Gradients become extremely small, preventing earlier layers from learning","GPU runs out of memory during backprop","The loss function never converges"],ans:1},
  {r:1,diff:"intermediate",cat:"AWS",q:"Which AWS service is a globally distributed NoSQL key-value and document database?",opts:["RDS","Aurora","DynamoDB","Redshift"],ans:2},
  // Round 2 — Easy-Hard
  {r:2,diff:"intermediate",cat:"AI/ML",q:"What is the purpose of a learning rate in neural network training?",opts:["Determines how many neurons are used","Controls how large each weight update step is","Sets the number of training epochs","Defines the activation function"],ans:1},
  {r:2,diff:"intermediate",cat:"AWS",q:"Which AWS networking component controls traffic in and out of a subnet at the subnet level?",opts:["Security Groups","WAF","NACLs (Network ACLs)","Route Tables"],ans:2},
  {r:2,diff:"intermediate",cat:"AI/ML",q:"What distinguishes a recurrent neural network (RNN) from a feedforward network?",opts:["RNNs use more layers","RNNs have connections that feed outputs back as inputs, enabling sequence memory","RNNs only work with images","RNNs do not use backpropagation"],ans:1},
  {r:2,diff:"intermediate",cat:"AWS",q:"What does Amazon Bedrock primarily provide?",opts:["A managed Kubernetes service","API access to foundation models from multiple providers","A NoSQL database for AI workloads","A container registry"],ans:1},
  {r:2,diff:"intermediate",cat:"AI/ML",q:"In machine learning what does 'batch size' refer to?",opts:["Number of layers in the model","Number of training samples processed before updating model weights","Total number of training examples","Number of GPUs used for training"],ans:1},
  {r:2,diff:"intermediate",cat:"AWS",q:"Which AWS service provides real-time processing of streaming data at scale?",opts:["SQS","S3","Kinesis Data Streams","Glue"],ans:2},
  {r:2,diff:"intermediate",cat:"AI/ML",q:"What is the role of an embedding in NLP models?",opts:["Compress audio files","Convert tokens/words into dense numerical vectors that capture semantic meaning","Encrypt model weights","Cache model outputs"],ans:1},
  {r:2,diff:"intermediate",cat:"AWS",q:"What is AWS Step Functions used for?",opts:["Running batch ML training jobs","Orchestrating multi-step workflows with state machines","Managing IAM permissions","Deploying Lambda functions"],ans:1},
  {r:2,diff:"intermediate",cat:"AI/ML",q:"What does F1-score balance between?",opts:["Accuracy and loss","Precision and recall","Training time and inference time","Model size and accuracy"],ans:1},
  {r:2,diff:"intermediate",cat:"AWS",q:"Which AWS service provides a global CDN for low-latency content delivery?",opts:["Route 53","CloudFront","Global Accelerator","Direct Connect"],ans:1},
  // Round 3 — Hard
  {r:3,diff:"hard",cat:"AI/ML",q:"What problem does batch normalisation solve during deep network training?",opts:["Reduces number of parameters","Stabilises training by normalising layer inputs, reducing internal covariate shift","Prevents the model from memorising training data","Speeds up data loading"],ans:1},
  {r:3,diff:"hard",cat:"AWS",q:"In AWS VPC, what is the purpose of a NAT Gateway?",opts:["Expose private resources to the internet","Allow private subnet instances to initiate outbound internet traffic without being directly reachable","Peer two VPCs together","Provide DNS resolution"],ans:1},
  {r:3,diff:"hard",cat:"AI/ML",q:"What is the key innovation of the transformer architecture over LSTMs for sequence modelling?",opts:["Uses more layers","Self-attention enables parallel processing of entire sequences without sequential dependencies","Transformers are smaller in size","Transformers use fewer training samples"],ans:1},
  {r:3,diff:"hard",cat:"AWS",q:"Which AWS service would you use to implement a data lakehouse combining S3 storage with SQL analytics?",opts:["RDS","DynamoDB","Amazon Athena with AWS Glue","Amazon ElastiCache"],ans:2},
  {r:3,diff:"hard",cat:"AI/ML",q:"What is the purpose of the softmax function in the output layer of a classification network?",opts:["Introduce non-linearity in hidden layers","Convert raw logits into a probability distribution over classes","Normalise input features","Compute gradient for backpropagation"],ans:1},
  {r:3,diff:"hard",cat:"AWS",q:"Which AWS service provides ML-powered intelligent threat detection for AWS accounts and workloads?",opts:["AWS Shield","Amazon Macie","Amazon GuardDuty","AWS WAF"],ans:2},
  {r:3,diff:"hard",cat:"AI/ML",q:"What is 'transfer learning' and why is it powerful for small datasets?",opts:["Training a model from scratch on new data; fast because less data needed","Reusing weights from a pre-trained model on a related task; the model already has learned useful representations","Moving model files between cloud providers","Compressing a large model into a smaller one"],ans:1},
  {r:3,diff:"hard",cat:"AWS",q:"How does Amazon Aurora differ from standard Amazon RDS?",opts:["Aurora is a NoSQL database; RDS is relational","Aurora is AWS's proprietary cloud-native relational DB with up to 5× MySQL performance and automatic storage scaling","Aurora only supports PostgreSQL; RDS supports multiple engines","Aurora requires manual backups; RDS is automated"],ans:1},
  {r:3,diff:"hard",cat:"AI/ML",q:"What does the term 'tokenisation' mean in the context of LLMs?",opts:["Encrypting model weights","Splitting input text into sub-word units that the model can process numerically","Chunking documents for vector storage","Compressing embeddings"],ans:1},
  {r:3,diff:"hard",cat:"AWS",q:"Which AWS compute option is most cost-effective for fault-tolerant, flexible batch ML training workloads?",opts:["On-Demand EC2","Reserved Instances","Spot Instances","Dedicated Hosts"],ans:2},
  // Round 4 — Very Hard
  {r:4,diff:"hard",cat:"AI Advanced",q:"What does Retrieval-Augmented Generation (RAG) solve that vanilla LLMs struggle with?",opts:["Slow inference speed","Lack of up-to-date or domain-specific knowledge by retrieving relevant context before generating","High training cost","Small context window size"],ans:1},
  {r:4,diff:"hard",cat:"AWS",q:"In a RAG architecture on AWS which combination is most commonly used for vector search?",opts:["DynamoDB + Lambda","Amazon OpenSearch Service + Bedrock Embeddings","Redshift + Glue","RDS + SageMaker"],ans:1},
  {r:4,diff:"hard",cat:"AI Advanced",q:"What is RLHF and what problem does it address in LLM training?",opts:["Recursive Layered Hierarchical Fine-tuning; reduces model size","Reinforcement Learning from Human Feedback; aligns model outputs to human preferences and safety","Real-time Learned High-Fidelity; speeds up inference","Randomised Loss Heuristic Function; prevents overfitting"],ans:1},
  {r:4,diff:"hard",cat:"AWS",q:"Which AWS service provides a managed feature store for storing, sharing, and reusing ML features?",opts:["Amazon Redshift","AWS Glue Data Catalog","Amazon SageMaker Feature Store","Amazon DynamoDB"],ans:2},
  {r:4,diff:"hard",cat:"AI Advanced",q:"What is 'hallucination' in LLMs and what architectural factor contributes to it?",opts:["Model refusal; caused by RLHF","Generating confident factually incorrect output; caused by training to predict plausible token sequences without grounding","Slow generation; caused by large context","Model crashes; caused by insufficient GPU memory"],ans:1},
  {r:4,diff:"hard",cat:"AWS",q:"What is the difference between Amazon SQS Standard and FIFO queues?",opts:["Standard supports more regions; FIFO is global","Standard offers best-effort ordering and at-least-once delivery; FIFO guarantees exact ordering and exactly-once processing","Standard is cheaper but unavailable in us-east-1","FIFO is a type of SNS topic; Standard is a true queue"],ans:1},
  {r:4,diff:"hard",cat:"AI Advanced",q:"What does quantisation do when deploying large language models?",opts:["Increases model accuracy by adding more training data","Reduces model precision (e.g. from FP32 to INT8) to shrink memory footprint and speed up inference","Adds more layers to improve model quality","Encrypts weights for secure deployment"],ans:1},
  {r:4,diff:"hard",cat:"AWS",q:"Which AWS pattern ensures ML experiment reproducibility across multiple training runs?",opts:["Use only Lambda for training","Pin container image versions, log hyperparameters, and store artefacts with versioned S3 paths in SageMaker Experiments","Store only final weights in S3 without metadata","Use EC2 Spot only and restart on interruption"],ans:1},
  {r:4,diff:"hard",cat:"AI Advanced",q:"What is the purpose of a system prompt in LLM API usage?",opts:["It sets GPU memory limits for the model","It provides persistent instructions that shape model behaviour, tone, and constraints across the conversation","It caches the conversation history for speed","It defines the tokenisation scheme"],ans:1},
  {r:4,diff:"hard",cat:"AWS",q:"Which AWS service automatically scales containerised microservices and handles traffic routing without managing infrastructure?",opts:["EC2 Auto Scaling","AWS App Runner","AWS Fargate with ECS","Amazon Lightsail"],ans:1},
  // Round 5 — Expert
  {r:5,diff:"expert",cat:"AI Expert",q:"What is LoRA (Low-Rank Adaptation) and why is it preferred over full fine-tuning for LLMs?",opts:["A new transformer architecture; preferred because it uses fewer layers","A technique that injects small trainable rank-decomposition matrices into frozen model weights, drastically reducing trainable parameters and GPU memory","A quantisation method; preferred for inference speed","A data augmentation strategy; preferred for small datasets"],ans:1},
  {r:5,diff:"expert",cat:"AWS",q:"In AWS, what is the key architectural difference between Kinesis Data Streams and Kinesis Data Firehose?",opts:["Streams is for batch; Firehose is for real-time","Streams requires custom consumers and enables real-time processing; Firehose is fully managed and delivers data to destinations like S3/Redshift automatically","Streams is cheaper; Firehose supports more regions","Firehose retains data 7 days; Streams does not retain data"],ans:1},
  {r:5,diff:"expert",cat:"AI Expert",q:"What distinguishes an encoder-only model (BERT) from a decoder-only model (GPT) architecturally?",opts:["BERT has more parameters; GPT is smaller","BERT uses bidirectional attention seeing full context for understanding tasks; GPT uses causal (left-to-right) attention for autoregressive generation","BERT is trained on images; GPT on text","BERT uses RL; GPT uses supervised learning only"],ans:1},
  {r:5,diff:"expert",cat:"AWS",q:"What is the shared responsibility model in AWS and who is responsible for data encryption at rest?",opts:["AWS is responsible for everything including encryption","The customer is responsible for encrypting their own data at rest; AWS secures the underlying infrastructure","Data encryption is optional and neither party is responsible","AWS encrypts automatically; customers manage keys only for on-premise"],ans:1},
  {r:5,diff:"expert",cat:"AI Expert",q:"What is constitutional AI as developed by Anthropic?",opts:["An AI trained purely on legal and regulatory documents","A training method that uses a set of explicit principles to guide model self-critique and revision, improving safety without extensive human labelling of every output","An ensemble of models governed by a voting committee","An AI that enforces software compliance rules"],ans:1},
  {r:5,diff:"expert",cat:"AWS",q:"How does AWS PrivateLink differ from VPC Peering for service connectivity?",opts:["PrivateLink is slower but cheaper; VPC Peering is faster","PrivateLink exposes a specific service endpoint privately without full network access; VPC Peering connects entire VPC CIDRs bidirectionally","PrivateLink only works within a single AZ; VPC Peering is multi-region","VPC Peering is deprecated; PrivateLink replaced it entirely"],ans:1},
  {r:5,diff:"expert",cat:"AI Expert",q:"What problem does sparse attention (e.g. Longformer) solve compared to standard self-attention?",opts:["Increases model accuracy on short sequences","Reduces the quadratic O(n²) complexity of full self-attention to near-linear, enabling processing of much longer sequences","Adds multi-modal support to transformers","Replaces positional encodings with relative attention"],ans:1},
  {r:5,diff:"expert",cat:"AWS",q:"In a multi-account AWS organisation, which service centrally manages security policies across all accounts?",opts:["AWS Config","AWS CloudTrail","AWS Control Tower with Service Control Policies (SCPs)","Amazon Inspector"],ans:2},
  {r:5,diff:"expert",cat:"AI Expert",q:"What is 'context window' in an LLM and what are the engineering trade-offs of increasing it?",opts:["The size of the training dataset; larger = more GPU needed","The maximum number of tokens the model can process at once; larger windows enable richer context but increase memory quadratically due to attention computation","The number of output tokens generated; larger = slower inference linearly","The number of model parameters; larger = higher accuracy but slower training"],ans:1},
  {r:5,diff:"expert",cat:"AWS",q:"Which approach is recommended for zero-downtime ML model updates on Amazon SageMaker?",opts:["Delete the endpoint and recreate it with a new model","Use SageMaker's blue/green deployment with traffic shifting to gradually route traffic to the new model version","Use Lambda to swap models manually","Restart the endpoint with new environment variables"],ans:1},
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Deterministic option shuffle keyed on question text — same result every time,
// so both browsers always see identical A/B/C/D letters for the same question.
function shuffleQ(q) {
  let seed = 0;
  for (const c of q.q) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const idx = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { ...q, opts: idx.map(i => q.opts[i]), ans: idx.indexOf(q.ans) };
}

// Called inside defGame() — each game gets its own independently shuffled list.
function buildQS() {
  return [1, 2, 3, 4, 5].flatMap(round => {
    const copy = RAW.filter(q => q.r === round).slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.map(shuffleQ);
  });
}

const ROUND_PTS = { 1:[1,0.5], 2:[2,1], 3:[3,1], 4:[4,2], 5:[5,2] };
const ROUND_META = {
  1:{ label:"ROUND 1", diff:"INTERMEDIATE", bgColor:"#7c3aed", sub:"10 questions · AI & AWS fundamentals at depth" },
  2:{ label:"ROUND 2", diff:"EASY-HARD",    bgColor:"#2563eb", sub:"10 questions · Deeper concepts & services" },
  3:{ label:"ROUND 3", diff:"HARD",         bgColor:"#0891b2", sub:"10 questions · Architecture & ML internals" },
  4:{ label:"ROUND 4", diff:"VERY HARD",    bgColor:"#d97706", sub:"10 questions · Advanced AI & cloud patterns" },
  5:{ label:"ROUND 5", diff:"EXPERT",       bgColor:"#dc2626", sub:"10 questions · Expert-level mastery" },
};

const games = {};
const WAITING_TEAM = "Waiting for challenger";

// ─── Game factory ─────────────────────────────────────────────────────────────
function defGame(teamA = "Alpha", teamB = WAITING_TEAM) {
  const qs = buildQS();
  return {
    names:        [teamA, teamB],
    scores:       [0, 0],
    correct:      [0, 0],
    wrong:        [0, 0],
    roundScores:  [[0,0],[0,0],[0,0],[0,0],[0,0]],
    history:      [[], []],
    qIndex:       0,
    currentTeam:  0,       // team whose turn it is to answer RIGHT NOW
    lastWinner:   0,       // BUG 4 FIX: team that last answered correctly (Team A default)
    answered:     false,   // true = question is fully resolved, ready for Next
    stealUsed:    false,   // true = the non-primary team already had their steal attempt
    screen:       "setupScreen",
    status:       "waiting",
    socketTeams:  {},      // BUG 3 FIX: socketId → team index (0 or 1)
    quitInfo:     null,    // ENHANCEMENT: set when a team ends the game early
    qs,
    total:        qs.length,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function createGame(code, teamA) {
  games[code] = defGame(teamA);
  return games[code];
}

function joinGame(code, teamB) {
  const game = games[code];
  if (!game) return null;
  if (game.status !== "waiting") return "FULL";
  game.names[1] = teamB || "Beta";
  game.status   = "ready";
  return game;
}

function startGame(code) {
  const game = games[code];
  if (!game || game.status === "waiting") return null;
  game.screen       = "quizScreen";
  game.status       = "playing";
  game.qIndex       = 0;
  game.answered     = false;
  game.stealUsed    = false;
  game.currentTeam  = 0;
  game.lastWinner   = 0;
  return game;
}

// BUG 3 FIX: register which socket belongs to which team (called from gameSocket.js)
function assignSocketTeam(code, socketId, teamIndex) {
  const game = games[code];
  if (!game) return;
  game.socketTeams[socketId] = teamIndex;
}

// Strips the answer index before sending to client — prevents cheating via devtools
function getQuestion(code) {
  const game = games[code];
  if (!game || game.qIndex >= game.total) return null;
  const { ans: _hidden, ...safe } = game.qs[game.qIndex];
  return safe;
}

function _applyPts(game, team, pts) {
  game.scores[team]      = Math.round((game.scores[team] + pts) * 10) / 10;
  if (pts > 0) game.correct[team]++;
  else if (pts < 0) game.wrong[team]++;
  const roundIdx = game.qs[game.qIndex].r - 1;
  game.roundScores[roundIdx][team] = Math.round((game.roundScores[roundIdx][team] + pts) * 10) / 10;
}

/**
 * handleAnswer
 *
 * BUG 1 FIX: Old guard was `if (game.answered && game.stealUsed) return null`.
 *   Problem: on the very first answer of a NEW question, `answered` and `stealUsed`
 *   were STILL true from the previous question because nextQuestion() always resets
 *   them — but the race between the socket event and the reset meant every other
 *   question arrived with stale flags.  Actually the simpler explanation: the guard
 *   was correct in intent but `stealUsed` was being set to true even during the steal
 *   PHASE (not just after steal is used), so the second-team steal attempt was blocked.
 *   Fix: guard is now just `if (game.answered) return null` — `answered` is only set
 *   to true when the question is FULLY resolved (correct answer OR both teams wrong).
 *   `stealUsed` purely tracks whether the steal opportunity has been consumed.
 *
 * BUG 3 FIX: callerTeam parameter — socket handler passes the team index of the
 *   socket that sent this event.  If it doesn't match currentTeam, reject silently.
 *
 * BUG 4 FIX: lastWinner is updated when a team answers correctly.  nextQuestion()
 *   reads lastWinner to set currentTeam for the next question.
 */
function handleAnswer(code, chosen, callerTeam) {
  const game = games[code];
  if (!game || game.qIndex >= game.total) return null;

  // BUG 1 FIX: only block when question is fully resolved
  if (game.answered) return null;

  // BUG 3 FIX: reject if it's not this team's turn
  if (callerTeam !== game.currentTeam) {
    return { result: { status: "not_your_turn", message: "Wait for your turn!", pts: 0 } };
  }

  const q          = game.qs[game.qIndex];
  const [pos, neg] = ROUND_PTS[q.r];
  const result     = { correct: false, pts: 0, next: false, message: "", status: "pending" };

  if (chosen === q.ans) {
    // ── Correct ───────────────────────────────────────────────────────────────
    const winnerName   = game.names[game.currentTeam];
    _applyPts(game, game.currentTeam, pos);
    game.history[game.currentTeam].push({ t:"c", v:"+"+pos, l:"Correct +"+pos });
    game.history[1-game.currentTeam].push({ t:"s", v:"—", l:"Skipped" });

    // BUG 4 FIX: record who won so nextQuestion can give them first chance
    game.lastWinner  = game.currentTeam;

    // After correct, flip currentTeam so the UI shows the OTHER team going first
    // on the NEXT question (nextQuestion() will apply lastWinner properly)
    game.answered    = true;   // question resolved
    game.stealUsed   = true;   // no steal needed
    game.currentTeam = 1 - game.currentTeam; // temporary — nextQuestion resets properly

    result.correct   = true;
    result.pts       = pos;
    result.status    = "correct";
    result.message   = `✓ Correct! ${winnerName} earns +${pos} pts and goes first next!`;

  } else {
    // ── Wrong ─────────────────────────────────────────────────────────────────
    const wrongName   = game.names[game.currentTeam];
    const stealerName = game.names[1 - game.currentTeam];
    _applyPts(game, game.currentTeam, -neg);
    game.history[game.currentTeam].push({ t:"w", v:"−"+neg, l:"Wrong −"+neg });

    if (!game.stealUsed) {
      // BUG 2 FIX: first wrong answer — mark steal used and switch active team.
      // `answered` stays FALSE so the stealer can still answer.
      game.stealUsed   = true;
      game.currentTeam = 1 - game.currentTeam;
      // answered remains false — stealer still needs to go
      result.status  = "steal";
      result.pts     = -neg;
      result.message = `✗ Wrong! ${wrongName} −${neg} pts. ${stealerName} gets a steal chance!`;

    } else {
      // Steal also wrong — question over, nobody scored
      game.answered  = true;
      result.next    = true;
      result.status  = "miss";
      result.pts     = -neg;
      result.message = "✗ Both teams missed. Moving on.";
    }
  }

  return { result };
}

/**
 * nextQuestion
 *
 * BUG 4 FIX: sets currentTeam = lastWinner so the team that last answered
 * correctly always gets the first attempt on the next question.
 * If nobody has answered correctly yet (or game just started), lastWinner = 0
 * (Team A goes first by default as per spec).
 */
function nextQuestion(code) {
  const game = games[code];
  if (!game) return null;

  game.qIndex    += 1;
  game.answered   = false;
  game.stealUsed  = false;

  // BUG 4 FIX: winner of last question gets first go
  game.currentTeam = game.lastWinner;

  if (game.qIndex >= game.total) {
    game.screen = "winnerScreen";
    game.status = "finished";
  }

  return game;
}

function restartGame(code) {
  const old = games[code];
  if (!old) return null;
  // Preserve socket→team assignments so reconnect still works
  const oldSocketTeams = { ...old.socketTeams };
  games[code]             = defGame(old.names[0], old.names[1]);
  games[code].status      = "playing";
  games[code].screen      = "quizScreen";
  games[code].socketTeams = oldSocketTeams;
  return games[code];
}

/**
 * quitGame — ENHANCEMENT: either team can end the match early.
 *
 * Marks the room finished so both browsers flip to the winner/summary
 * screen with whatever scores exist so far. `quitInfo` records WHICH team
 * ended it, so the frontend can show "Team X ended the match" instead of
 * the normal "completed all 5 rounds" framing.
 *
 * Returns the game object (for the caller to broadcast) or null if the
 * room doesn't exist.
 */
function quitGame(code, quittingTeam) {
  const game = games[code];
  if (!game) return null;
  game.screen   = "winnerScreen";
  game.status   = "finished";
  game.quitInfo = {
    quit: true,
    byTeam: quittingTeam,
    byName: game.names[quittingTeam] ?? "A team",
  };
  return game;
}

/**
 * getState — full snapshot sent to both clients after every event.
 *
 * `activeTeam` is the team index that is ALLOWED to click right now.
 *   Frontend uses this to enable/disable buttons per browser session.
 */
function getState(code) {
  const game = games[code];
  if (!game) return null;

  const isFinished      = game.qIndex >= game.total;
  const question        = isFinished ? null : getQuestion(code);
  const currentRound    = question ? question.r : null;
  const roundMeta       = currentRound ? ROUND_META[currentRound] : null;
  const isRoundBoundary = !isFinished && game.qIndex > 0 && game.qIndex % 10 === 0;

  return {
    names:           game.names,
    scores:          game.scores,
    correct:         game.correct,
    wrong:           game.wrong,
    roundScores:     game.roundScores,
    history:         game.history,
    qIndex:          game.qIndex,
    currentTeam:     game.currentTeam,
    activeTeam:      game.answered ? -1 : game.currentTeam, // -1 = nobody (question over)
    answered:        game.answered,
    stealUsed:       game.stealUsed,
    screen:          game.screen,
    status:          game.status,
    question,
    roundMeta,
    isRoundBoundary,
    total:           game.total,
    socketTeams:     game.socketTeams, // lets client know its own team index
    quitInfo:        game.quitInfo,    // ENHANCEMENT: non-null only if a team quit early
  };
}

module.exports = {
  createGame, joinGame, startGame,
  assignSocketTeam,
  handleAnswer, nextQuestion, restartGame, quitGame, getState,
};